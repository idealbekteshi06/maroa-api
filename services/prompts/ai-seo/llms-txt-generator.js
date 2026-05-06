'use strict';

/**
 * services/prompts/ai-seo/llms-txt-generator.js
 * ----------------------------------------------------------------------------
 * Build a valid /llms.txt file for the customer's site.
 *
 * Spec (Anthropic / community / proposed standard):
 *   # <Site Name>
 *   > <Short tagline / what we do>
 *
 *   ## <Section>
 *   - [Page Title](URL): <one-line description>
 *
 * Goal: ≤140 tokens for /llms.txt; full content version for /llms-full.txt.
 *
 * Pure deterministic — does NOT call LLM. Caller may compose this with
 * LLM-generated content for richer copy.
 * ----------------------------------------------------------------------------
 */

function escapeMd(s) {
  if (s == null) return '';
  return String(s)
    .replace(/[\[\]()`*_>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Build a basic llms.txt from a business profile + optional pages.
 *
 * pages: [{ title, url, summary }]
 */
function buildLlmsTxt({ business, pages = [], primaryLanguage = 'en' }) {
  const name = escapeMd(business?.business_name || 'Business');
  const tagline = clamp(escapeMd(business?.tagline || business?.usp || business?.business_type || ''), 160);
  const country = escapeMd(business?.country_code || business?.country || '');
  const industry = escapeMd(business?.industry || business?.business_type || '');

  const lines = [];
  lines.push(`# ${name}`);
  if (tagline) lines.push(`> ${tagline}`);
  lines.push('');
  if (industry || country) {
    const meta = [industry, country].filter(Boolean).join(' · ');
    lines.push(`*${meta}*`);
    lines.push('');
  }

  if (pages.length) {
    lines.push('## Key Pages');
    for (const p of pages.slice(0, 10)) {
      const title = escapeMd(p.title || p.url || 'Page');
      const url = p.url || '#';
      const summary = clamp(escapeMd(p.summary || ''), 100);
      lines.push(summary ? `- [${title}](${url}): ${summary}` : `- [${title}](${url})`);
    }
    lines.push('');
  }

  if (Array.isArray(business?.products) && business.products.length) {
    lines.push('## Products / Services');
    for (const p of business.products.slice(0, 10)) {
      const t = clamp(escapeMd(typeof p === 'string' ? p : (p.name || p.title || '')), 80);
      if (t) lines.push(`- ${t}`);
    }
    lines.push('');
  }

  if (business?.audience_description) {
    lines.push('## Who We Serve');
    lines.push(clamp(escapeMd(business.audience_description), 200));
    lines.push('');
  }

  if (business?.location || country) {
    lines.push('## Location');
    lines.push(escapeMd(business.location || country));
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`Language: ${primaryLanguage}`);
  if (business?.last_updated) lines.push(`Last updated: ${business.last_updated}`);

  return lines.join('\n').trim() + '\n';
}

/**
 * Build the full-content version with full page bodies inline.
 * pages: [{ title, url, summary, content }]
 */
function buildLlmsFullTxt({ business, pages = [], primaryLanguage = 'en' }) {
  const head = buildLlmsTxt({ business, pages, primaryLanguage });
  if (!pages.length) return head;
  const body = ['', '---', '', '# Full Content', ''];
  for (const p of pages) {
    body.push(`## ${escapeMd(p.title || p.url || 'Page')}`);
    if (p.url) body.push(`[Source](${p.url})`);
    body.push('');
    if (p.content) body.push(clamp(p.content, 8000));
    body.push('');
  }
  return head + body.join('\n').trim() + '\n';
}

/**
 * Token estimate (rough — 4 chars/token rule of thumb, used for the ≤140 token
 * target on /llms.txt). Real tokenization varies by model; this is conservative.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

module.exports = {
  buildLlmsTxt,
  buildLlmsFullTxt,
  estimateTokens,
};
