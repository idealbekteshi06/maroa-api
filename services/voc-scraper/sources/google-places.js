'use strict';

/**
 * services/voc-scraper/sources/google-places.js
 * ---------------------------------------------------------------------------
 * Fetch reviews from a business's Google Maps listing via the Places API.
 *
 * Why Google first: it's the highest-density review source for SMBs (cafés,
 * salons, gyms, dentists — Maroa's core ICP). Customers leave detailed
 * reviews here because Google ranks them prominently in local search.
 *
 * Cost: $17 per 1000 Place Details requests (which include up to 5 reviews
 * each). For a customer with 50 reviews, that's ~10 requests = $0.17. Cheap
 * enough to refresh weekly for every customer.
 *
 * Environment:
 *   GOOGLE_PLACES_API_KEY  (required) — get one at console.cloud.google.com
 *
 * Public API:
 *   fetch({ placeId, businessName?, city?, limit? })
 *     → { ok, reviews: [{rating, text, author, time}], source, placeId }
 *
 * Failure modes:
 *   - No API key → returns { ok: false, reason: 'GOOGLE_PLACES_API_KEY not set' }
 *   - placeId missing → tries to resolve via Find Place if businessName + city given
 *   - Resolve fails → returns { ok: false, reason: 'no match' }
 *   - API error → returns { ok: false, status, reason: error.message }
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
 * Find a placeId from business name + city. Useful when the user
 * hasn't manually provided a placeId.
 *
 * Uses Find Place from Text — 1 request, returns the best match.
 */
async function resolvePlaceId({ businessName, city, apiKey }) {
  if (!businessName) return null;
  const input = city ? `${businessName} ${city}` : businessName;
  const url = `${PLACES_BASE}/findplacefromtext/json?input=${encodeURIComponent(
    input
  )}&inputtype=textquery&fields=place_id,name&key=${apiKey}`;
  const r = await _httpGetJSON(url);
  if (!r.ok || !r.json) return null;
  const candidate = r.json.candidates?.[0];
  return candidate?.place_id || null;
}

/**
 * Fetch reviews for a placeId. The Place Details endpoint returns up to 5
 * of the most recent / most relevant reviews per request. To get more, the
 * Places API doesn't pageinate — you'd need the (more expensive) Place
 * Details "reviews" field with explicit sort options. For most SMBs, the
 * top 5 most-relevant reviews are the highest-signal sample, so we don't
 * paginate by default.
 *
 * @param {string} placeId  Google Place ID
 * @param {string} apiKey   Google Places API key
 * @param {string} language Optional ISO code, e.g. 'sq' for Albanian
 */
async function fetchPlaceDetails({ placeId, apiKey, language }) {
  if (!placeId || !apiKey) return null;
  const langParam = language ? `&language=${encodeURIComponent(language)}` : '';
  const url = `${PLACES_BASE}/details/json?place_id=${encodeURIComponent(
    placeId
  )}&fields=name,reviews,rating,user_ratings_total${langParam}&key=${apiKey}`;
  const r = await _httpGetJSON(url);
  if (!r.ok || !r.json) return null;
  return r.json.result || null;
}

/**
 * Main entrypoint. Returns the normalized review array.
 *
 * Pass `_httpGetJSONOverride` for tests — lets us stub the HTTP layer
 * without monkey-patching fetch.
 */
async function fetch_({ placeId, businessName, city, language, limit = 5, apiKey, _httpGetJSONOverride } = {}) {
  const key = apiKey || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, reason: 'GOOGLE_PLACES_API_KEY not set', source: 'google_places' };

  // Allow tests to inject the HTTP layer
  const _get = _httpGetJSONOverride || _httpGetJSON;

  let resolvedPlaceId = placeId;
  if (!resolvedPlaceId) {
    if (!businessName) return { ok: false, reason: 'placeId or businessName required', source: 'google_places' };
    const input = city ? `${businessName} ${city}` : businessName;
    const findUrl = `${PLACES_BASE}/findplacefromtext/json?input=${encodeURIComponent(
      input
    )}&inputtype=textquery&fields=place_id,name&key=${key}`;
    const r = await _get(findUrl);
    if (!r.ok || !r.json) return { ok: false, reason: 'find place failed', source: 'google_places' };
    resolvedPlaceId = r.json.candidates?.[0]?.place_id || null;
    if (!resolvedPlaceId) return { ok: false, reason: 'no match', source: 'google_places' };
  }

  const langParam = language ? `&language=${encodeURIComponent(language)}` : '';
  const detailsUrl = `${PLACES_BASE}/details/json?place_id=${encodeURIComponent(
    resolvedPlaceId
  )}&fields=name,reviews,rating,user_ratings_total${langParam}&key=${key}`;
  const r = await _get(detailsUrl);
  if (!r.ok || !r.json) {
    return { ok: false, reason: 'details fetch failed', source: 'google_places', status: r.status };
  }
  const result = r.json.result || {};
  const rawReviews = Array.isArray(result.reviews) ? result.reviews : [];
  const reviews = rawReviews
    .slice(0, limit)
    .map((rv) => ({
      rating: Number(rv.rating) || null,
      text: typeof rv.text === 'string' ? rv.text.trim() : '',
      author: typeof rv.author_name === 'string' ? rv.author_name : '',
      time: typeof rv.time === 'number' ? new Date(rv.time * 1000).toISOString() : null,
      lang: rv.language || null,
    }))
    .filter((r) => r.text);

  return {
    ok: true,
    source: 'google_places',
    placeId: resolvedPlaceId,
    business_rating: typeof result.rating === 'number' ? result.rating : null,
    review_count_total: typeof result.user_ratings_total === 'number' ? result.user_ratings_total : null,
    reviews,
  };
}

module.exports = {
  fetch: fetch_,
  resolvePlaceId,
  fetchPlaceDetails,
  _httpGetJSON,
};
