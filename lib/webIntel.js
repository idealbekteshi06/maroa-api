'use strict';

/**
 * lib/webIntel.js — web-search-grounded Claude calls (2026-07 upgrade).
 *
 * Wraps callClaude's server-side web_search/web_fetch tools (the _20260209
 * dynamic-filtering variants on Sonnet 5 / Opus 4.8) and normalizes the full
 * response body into { text, citedUrls, searchCount }. This is the
 * SerpAPI-reduction path: competitor-watch's web intelligence sweep and
 * citation-tracker's `claude` engine both ride it — one vendor, results
 * arrive pre-filtered with citations, no scraping code.
 */

/** Extract joined text + cited URLs from a raw Messages API response body. */
function parseWebSearchResponse(body) {
  const textParts = [];
  const citedUrls = [];
  let searchCount = 0;
  for (const block of body?.content || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
      // Citations attached to text blocks (web_search_result_location)
      for (const c of block.citations || []) {
        if (c?.url) citedUrls.push(c.url);
      }
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      searchCount += 1;
    } else if (block.type === 'web_search_tool_result') {
      const content = block.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.url) citedUrls.push(item.url);
        }
      }
      // Error results arrive as an object ({error_code}) — no URLs to collect.
    }
  }
  return {
    text: textParts.join('\n').trim(),
    citedUrls: [...new Set(citedUrls)],
    searchCount,
  };
}

/**
 * Run a web-grounded Claude query. Returns { ok, text, citedUrls,
 * searchCount } — soft-fails with { ok:false, reason } (a web sweep must
 * never break the cron that invoked it).
 *
 * opts: { callClaude, prompt, system, businessId, skill, model, maxTokens,
 *         maxSearches, allowedDomains, blockedDomains }
 */
async function webSearchQuery(opts) {
  const {
    callClaude,
    prompt,
    system,
    businessId,
    skill = 'web_intel',
    model = 'claude-sonnet-5',
    maxTokens = 2000,
    maxSearches = 3,
    allowedDomains,
    blockedDomains,
  } = opts || {};
  if (typeof callClaude !== 'function') return { ok: false, reason: 'callClaude_required' };
  if (!prompt) return { ok: false, reason: 'prompt_required' };
  try {
    const body = await callClaude(prompt, model, maxTokens, {
      system,
      businessId,
      skill,
      returnFullResponse: true,
      webSearch: {
        max_uses: maxSearches,
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
        ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
      },
    });
    const parsed = parseWebSearchResponse(body);
    return { ok: true, ...parsed };
  } catch (e) {
    return { ok: false, reason: 'web_search_failed', detail: String(e.message || '').slice(0, 300) };
  }
}

module.exports = { webSearchQuery, parseWebSearchResponse };
