'use strict';

/**
 * services/voc-scraper/sources/trustpilot.js
 * ---------------------------------------------------------------------------
 * Fetch reviews from Trustpilot's Business API.
 *
 * NOTE on availability: Trustpilot's public reviews API requires a paid
 * Business Plan ($300+/mo). The free API only gives you a business
 * profile, not reviews. This adapter is a STUB that uses the same shape
 * as the other adapters so the orchestrator can be configured to attempt
 * Trustpilot when the env var is set, and silently skip when it isn't.
 *
 * If/when Maroa subscribes to the Trustpilot Business Plan, swap
 * `_unsupported()` for actual API calls. The shape is documented at:
 *   developers.trustpilot.com/business-units-api
 *
 * Environment:
 *   TRUSTPILOT_API_KEY  (optional — without it the adapter no-ops)
 *
 * Public API: same shape as google-places.js + yelp.js
 * ---------------------------------------------------------------------------
 */

const TRUSTPILOT_BASE = 'https://api.trustpilot.com/v1';

async function _httpGetJSON(url, apiKey) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { apikey: apiKey },
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

async function fetch_({ businessUnitId, domain, limit = 10, apiKey, _httpGetJSONOverride } = {}) {
  const key = apiKey || process.env.TRUSTPILOT_API_KEY;
  if (!key) {
    // Soft-fail — orchestrator should silently skip when Trustpilot isn't configured.
    return { ok: false, reason: 'TRUSTPILOT_API_KEY not set', source: 'trustpilot' };
  }
  const _get = _httpGetJSONOverride || _httpGetJSON;

  let unitId = businessUnitId;
  if (!unitId) {
    if (!domain) {
      return { ok: false, reason: 'businessUnitId or domain required', source: 'trustpilot' };
    }
    // Find business unit by domain
    const findUrl = `${TRUSTPILOT_BASE}/business-units/find?name=${encodeURIComponent(domain)}`;
    const r = await _get(findUrl, key);
    if (!r.ok || !r.json) {
      return { ok: false, reason: 'find business unit failed', source: 'trustpilot', status: r.status };
    }
    unitId = r.json.id || null;
    if (!unitId) return { ok: false, reason: 'no match', source: 'trustpilot' };
  }

  // Pull most recent reviews
  const reviewsUrl = `${TRUSTPILOT_BASE}/business-units/${encodeURIComponent(
    unitId
  )}/reviews?perPage=${Math.min(limit, 100)}&orderBy=createdat.desc`;
  const r = await _get(reviewsUrl, key);
  if (!r.ok || !r.json) {
    return { ok: false, reason: 'reviews fetch failed', source: 'trustpilot', status: r.status };
  }
  const rawReviews = Array.isArray(r.json.reviews) ? r.json.reviews : [];
  const reviews = rawReviews
    .slice(0, limit)
    .map((rv) => ({
      rating: typeof rv.stars === 'number' ? rv.stars : null,
      text: typeof rv.text === 'string' ? rv.text.trim() : '',
      author: rv.consumer?.displayName || '',
      time: rv.createdAt || null,
      lang: rv.language || null,
    }))
    .filter((r) => r.text);

  return {
    ok: true,
    source: 'trustpilot',
    businessUnitId: unitId,
    reviews,
  };
}

module.exports = {
  fetch: fetch_,
  _httpGetJSON,
};
