'use strict';

/**
 * lib/websiteEnricher.js
 * ---------------------------------------------------------------------------
 * Fetches a customer's own website, has Claude read it, and returns a concise
 * structured summary so the brand context can "know the business from the
 * website" instead of only storing the raw URL string.
 *
 * Persisted by the caller into businesses.website_summary (+ website_enriched_at,
 * migration 088) and injected into the brand context render.
 *
 * Safety:
 *  - Only http/https URLs are fetched.
 *  - SSRF guard: literal localhost / private / link-local / cloud-metadata
 *    hosts are refused. (Full DNS-rebinding protection would need resolve-time
 *    IP checks; this blocks the obvious internal targets — see TODO.)
 *  - Hard fetch timeout; HTML is stripped to text and truncated before the
 *    model sees it. Never throws — returns { ok:false, reason } on any failure.
 * ---------------------------------------------------------------------------
 */

const FETCH_TIMEOUT_MS = 10000;
const MAX_TEXT_CHARS = 6000;

// Hostnames / IP literals we never fetch (SSRF). Matches the obvious internal
// targets; DNS-based rebinding is out of scope for this guard (TODO: resolve
// + re-check the IP before connect when we move off global fetch).
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  // IPv4 private / loopback / link-local + cloud metadata (169.254.169.254).
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // A non-http(s) scheme (ftp://, file://, javascript:, …) is rejected, not
  // coerced. Only a bare host (no scheme) gets https:// prepended.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return null;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return null; // schemes without // (javascript:, mailto:, data:)
  } else {
    s = `https://${s}`;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  return u.toString();
}

// Crude but dependency-free HTML → text: drop script/style, strip tags,
// collapse whitespace, decode a few common entities, truncate.
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function buildSummaryPrompt(url, text) {
  return [
    'You are analyzing a small business from the text of its own website.',
    'Extract a tight, factual brief the marketing system can use. No fluff,',
    'no invented facts — only what the page supports. Output JSON ONLY:',
    '{',
    '  "business_description": "1-2 sentences: what they do + who for",',
    '  "products_services": ["short", "list", "of offerings"],',
    '  "differentiator": "what sets them apart, if stated (else empty string)",',
    '  "tone": "the brand voice you observe (e.g. warm, premium, playful)",',
    '  "summary": "<= 400 char paragraph the brain can read as context"',
    '}',
    '',
    `URL: ${url}`,
    `PAGE TEXT: ${JSON.stringify(text)}`,
  ].join('\n');
}

/**
 * Fetch + summarize a customer website.
 * @param {object} args
 * @param {string} args.url           the customer-provided website URL
 * @param {object} args.deps          { callClaude, extractJSON, logger?, fetchImpl? }
 * @param {string} [args.businessId]
 * @returns {Promise<{ok:boolean, url?:string, summary?:string, structured?:object, reason?:string}>}
 */
async function enrichFromWebsite({ url, deps, businessId }) {
  const { callClaude, extractJSON, logger } = deps || {};
  const fetchImpl = deps?.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  const safeUrl = normalizeUrl(url);
  if (!safeUrl) return { ok: false, reason: 'invalid_or_blocked_url' };
  if (!fetchImpl) return { ok: false, reason: 'no_fetch_available' };
  if (typeof callClaude !== 'function' || typeof extractJSON !== 'function') {
    return { ok: false, reason: 'llm_unavailable' };
  }

  let html;
  try {
    const res = await fetchImpl(safeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'MaroaBot/1.0 (+https://maroa.ai)' },
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    html = await res.text();
  } catch (e) {
    logger?.warn?.('websiteEnricher', businessId, 'fetch failed', { url: safeUrl, error: e.message });
    return { ok: false, reason: 'fetch_failed', error: e.message };
  }

  const text = htmlToText(html);
  if (text.length < 40) return { ok: false, reason: 'too_little_content' };

  try {
    const raw = await callClaude(buildSummaryPrompt(safeUrl, text), 'claude-haiku-4-5', 600, {
      businessId,
      returnRaw: true,
      skipBudget: false,
    });
    const parsed = extractJSON(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.summary) {
      return { ok: false, reason: 'unparseable_summary' };
    }
    return {
      ok: true,
      url: safeUrl,
      summary: String(parsed.summary).slice(0, 400),
      structured: {
        business_description: String(parsed.business_description || '').slice(0, 400),
        products_services: Array.isArray(parsed.products_services)
          ? parsed.products_services.slice(0, 12).map((p) => String(p).slice(0, 80))
          : [],
        differentiator: String(parsed.differentiator || '').slice(0, 300),
        tone: String(parsed.tone || '').slice(0, 120),
      },
    };
  } catch (e) {
    logger?.warn?.('websiteEnricher', businessId, 'summarize failed', { error: e.message });
    return { ok: false, reason: 'summarize_failed', error: e.message };
  }
}

module.exports = { enrichFromWebsite, normalizeUrl, isBlockedHost, htmlToText };
