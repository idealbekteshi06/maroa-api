'use strict';

/**
 * services/public-pretrainer/sources/google-places-cohort.js
 * ---------------------------------------------------------------------------
 * Aggregate Google Places reviews from the top-N businesses per (industry,
 * region) cohort. Builds a corpus of REAL customer voice for any vertical.
 *
 * Flow:
 *   1. textsearch — find top-N businesses matching "<industry> in <region>"
 *   2. details    — for each, pull rating + up-to-5 reviews
 *   3. emit normalized review rows with high-quality scoring when reviews
 *      come from highly-rated establishments
 *
 * Cost: ~$17 per 1000 textsearch/details requests. For seeding 20 industries
 * × 20 regions × 10 businesses × 2 requests (search + details) = ~$135.
 * One-time cost, then weekly refresh of just the top performers (~$15/week).
 *
 * Environment:
 *   GOOGLE_PLACES_API_KEY  (required)
 * ---------------------------------------------------------------------------
 */

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

async function _httpGetJSON(url) {
  const res = await fetch(url);
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
 * Find the top-N businesses matching a query like "best café in Tirana".
 * Returns place_ids + names.
 */
async function findTopBusinesses({ query, apiKey, limit = 10, _httpGetJSONOverride } = {}) {
  const _get = _httpGetJSONOverride || _httpGetJSON;
  const url = `${PLACES_BASE}/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
  const r = await _get(url);
  if (!r.ok || !r.json) return [];
  const results = Array.isArray(r.json.results) ? r.json.results : [];
  return results
    .slice(0, limit)
    .filter((p) => typeof p.rating === 'number' && p.rating >= 4.0) // quality filter
    .map((p) => ({
      placeId: p.place_id,
      name: p.name,
      rating: p.rating,
      reviewCount: p.user_ratings_total || 0,
    }));
}

/**
 * Fetch reviews for a single placeId.
 */
async function fetchReviewsForPlace({ placeId, apiKey, language, _httpGetJSONOverride } = {}) {
  const _get = _httpGetJSONOverride || _httpGetJSON;
  const lang = language ? `&language=${encodeURIComponent(language)}` : '';
  const url = `${PLACES_BASE}/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=name,reviews,rating,user_ratings_total${lang}&key=${apiKey}`;
  const r = await _get(url);
  if (!r.ok || !r.json?.result) return null;
  return r.json.result;
}

/**
 * Main: fetch cohort reviews for an (industry seed-keyword, region) tuple.
 *
 * @param {object} args
 * @param {string} args.industryKeyword e.g. 'cafe' or 'best gym'
 * @param {string} args.regionLabel     e.g. 'Tirana, Albania' or 'New York, NY'
 * @param {string} args.regionCode      ISO-3166 (for tagging)
 * @param {number} args.businessLimit   top-N businesses to scan
 */
async function fetch_({
  industryKeyword,
  regionLabel,
  regionCode,
  businessLimit = 10,
  language,
  apiKey,
  _httpGetJSONOverride,
} = {}) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, reason: 'GOOGLE_PLACES_API_KEY not set', source: 'google_places_cohort' };
  if (!industryKeyword || !regionLabel) {
    return { ok: false, reason: 'industryKeyword + regionLabel required', source: 'google_places_cohort' };
  }

  // Step 1: top businesses
  const businesses = await findTopBusinesses({
    query: `${industryKeyword} in ${regionLabel}`,
    apiKey: key,
    limit: businessLimit,
    _httpGetJSONOverride,
  });
  if (businesses.length === 0) {
    return { ok: true, source: 'google_places_cohort', reviews: [], businesses: [] };
  }

  // Step 2: parallel review fetches
  const detailsTasks = businesses.map((biz) =>
    fetchReviewsForPlace({
      placeId: biz.placeId,
      apiKey: key,
      language,
      _httpGetJSONOverride,
    }).catch(() => null)
  );
  const detailsResults = await Promise.all(detailsTasks);

  const reviews = [];
  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i];
    const details = detailsResults[i];
    if (!details?.reviews) continue;
    for (const rv of details.reviews) {
      if (!rv.text) continue;
      reviews.push({
        source_ref: `${biz.placeId}:${rv.time}`,
        title: null,
        body: rv.text.trim(),
        cta: null,
        visual_brief: null,
        language: rv.language || null,
        region: regionCode,
        rating: typeof rv.rating === 'number' ? rv.rating : null,
        business_name: biz.name,
        business_rating: biz.rating,
        business_review_count: biz.reviewCount,
        review_time: typeof rv.time === 'number' ? new Date(rv.time * 1000).toISOString() : null,
      });
    }
  }

  return {
    ok: true,
    source: 'google_places_cohort',
    businesses,
    reviews,
    region: regionCode,
  };
}

module.exports = {
  fetch: fetch_,
  findTopBusinesses,
  fetchReviewsForPlace,
};
