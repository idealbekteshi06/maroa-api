'use strict';

/**
 * services/voc-scraper/sources/yelp.js
 * ---------------------------------------------------------------------------
 * Fetch reviews from Yelp Fusion API.
 *
 * Cost: free tier 5000 calls/day. More than enough for weekly refresh per
 * customer at any realistic scale.
 *
 * Yelp Fusion's review endpoint returns only EXCERPTS (~160 chars) for the
 * top 3 reviews per business, not full text. This is a hard limit of the
 * free Fusion API. For full reviews you'd need a Yelp partner agreement.
 * Excerpts are still useful — they contain the most-quoted lines.
 *
 * Environment:
 *   YELP_API_KEY  (required) — get at fusion.yelp.com
 *
 * Public API:
 *   fetch({ businessId?, businessName, city, limit? })
 *     → { ok, reviews, source }
 *
 * Failure modes:
 *   - No API key                → { ok: false, reason: 'YELP_API_KEY not set' }
 *   - No matching business      → { ok: false, reason: 'no match' }
 *   - API error                 → { ok: false, status, reason }
 * ---------------------------------------------------------------------------
 */

const YELP_BASE = 'https://api.yelp.com/v3';

async function _httpGetJSON(url, apiKey) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Search Yelp for the business by name + city, return the Yelp business id.
 */
async function searchBusinessId({ businessName, city, apiKey, _get }) {
  const term = encodeURIComponent(businessName);
  const location = encodeURIComponent(city || '');
  const url = `${YELP_BASE}/businesses/search?term=${term}&location=${location}&limit=1`;
  const r = await _get(url, apiKey);
  if (!r.ok || !r.json) return null;
  return r.json.businesses?.[0]?.id || null;
}

async function fetch_({ businessId, businessName, city, limit = 3, apiKey, _httpGetJSONOverride } = {}) {
  const key = apiKey || process.env.YELP_API_KEY;
  if (!key) return { ok: false, reason: 'YELP_API_KEY not set', source: 'yelp' };
  const _get = _httpGetJSONOverride || _httpGetJSON;

  let resolvedId = businessId;
  if (!resolvedId) {
    if (!businessName) return { ok: false, reason: 'businessId or businessName required', source: 'yelp' };
    resolvedId = await searchBusinessId({ businessName, city, apiKey: key, _get });
    if (!resolvedId) return { ok: false, reason: 'no match', source: 'yelp' };
  }

  const url = `${YELP_BASE}/businesses/${encodeURIComponent(resolvedId)}/reviews?limit=${Math.min(limit, 3)}`;
  const r = await _get(url, key);
  if (!r.ok || !r.json) {
    return { ok: false, reason: 'reviews fetch failed', source: 'yelp', status: r.status };
  }
  const rawReviews = Array.isArray(r.json.reviews) ? r.json.reviews : [];
  const reviews = rawReviews
    .map((rv) => ({
      rating: Number(rv.rating) || null,
      // Yelp returns excerpts only on the free tier
      text: typeof rv.text === 'string' ? rv.text.trim() : '',
      author: rv.user?.name || '',
      time: rv.time_created || null,
      lang: null,
    }))
    .filter((r) => r.text);

  return {
    ok: true,
    source: 'yelp',
    yelpBusinessId: resolvedId,
    review_count_total: typeof r.json.total === 'number' ? r.json.total : null,
    reviews,
  };
}

module.exports = {
  fetch: fetch_,
  searchBusinessId,
  _httpGetJSON,
};
