'use strict';

/**
 * services/public-pretrainer/sources/meta-ad-library.js
 * ---------------------------------------------------------------------------
 * Meta Ad Library API adapter.
 *
 * This is the highest-leverage corpus source. Every active Meta ad
 * globally is queryable via the public Ad Library API, designed by Meta
 * for exactly this use case (transparency, research, ad library access).
 *
 * Cost: free with a Meta developer access token. No request quota beyond
 * the standard Graph API rate limits.
 *
 * Environment:
 *   META_AD_LIBRARY_TOKEN  (required) — get one at developers.facebook.com
 *
 * API docs:
 *   https://www.facebook.com/ads/library/api/
 *
 * Public API:
 *
 *   fetchByPage({ pageName, region, limit?, ... })
 *     → { ok, ads: [{...}], source }
 *
 *   fetchByKeyword({ keyword, region, limit?, ... })
 *     → { ok, ads: [{...}], source }
 *
 * Each returned ad has:
 *   { source_ref, title, body, cta, visual_brief, language, region,
 *     runtime_days, page_name, ad_creative_link_caption, ... }
 *
 * Failure modes (soft):
 *   - No API token → { ok: false, reason: 'META_AD_LIBRARY_TOKEN not set' }
 *   - API error    → { ok: false, status, reason: error.message }
 *   - Rate limited → { ok: false, status: 429, reason: 'rate limit' }
 * ---------------------------------------------------------------------------
 */

const META_GRAPH = 'https://graph.facebook.com/v21.0';

// Meta Ad Library expects ISO 3166-1 alpha-2 country codes in ad_reached_countries.
// Aggregate regions (EU, GLOBAL, etc.) need to be expanded to the actual
// member countries by the orchestrator before calling this adapter.
const META_AGGREGATE_REGIONS = new Set(['EU', 'GLOBAL', 'NA', 'APAC', 'LATAM', 'MENA']);

async function _httpGetJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Build the search URL for Meta Ad Library API.
 *
 * @param {object} args
 * @param {string} args.token             API access token
 * @param {string} args.searchTerms       OPTIONAL — keyword search
 * @param {string} args.searchPageIds     OPTIONAL — comma-separated page IDs
 * @param {string} args.adReachedCountries ISO alpha-2 region code
 * @param {number} args.limit             page size (max 100 per Meta docs)
 */
function _buildSearchUrl({ token, searchTerms, searchPageIds, adReachedCountries, limit = 25 }) {
  const fields = [
    'id',
    'ad_creation_time',
    'ad_creative_bodies',
    'ad_creative_link_captions',
    'ad_creative_link_descriptions',
    'ad_creative_link_titles',
    'ad_delivery_start_time',
    'ad_delivery_stop_time',
    'ad_snapshot_url',
    'languages',
    'page_id',
    'page_name',
    'publisher_platforms',
    'target_locations',
    'ad_reached_countries',
  ].join(',');

  const params = new URLSearchParams({
    access_token: token,
    ad_reached_countries: `["${adReachedCountries}"]`,
    ad_active_status: 'ALL',
    ad_type: 'ALL',
    fields,
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  if (searchTerms) params.set('search_terms', searchTerms);
  if (searchPageIds) params.set('search_page_ids', searchPageIds);

  return `${META_GRAPH}/ads_archive?${params.toString()}`;
}

/**
 * Normalize a raw Meta ad row into our corpus shape.
 */
function normalizeAd(raw, regionHint) {
  // Meta returns multiple bodies / captions per ad — collapse to the
  // longest body (typically the most informative).
  const bodies = Array.isArray(raw.ad_creative_bodies) ? raw.ad_creative_bodies.filter(Boolean) : [];
  const longestBody = bodies.length ? bodies.reduce((a, b) => (b.length > a.length ? b : a)) : '';
  const titles = Array.isArray(raw.ad_creative_link_titles) ? raw.ad_creative_link_titles.filter(Boolean) : [];
  const ctas = Array.isArray(raw.ad_creative_link_captions) ? raw.ad_creative_link_captions.filter(Boolean) : [];

  const startMs = raw.ad_delivery_start_time ? new Date(raw.ad_delivery_start_time).getTime() : null;
  const stopMs = raw.ad_delivery_stop_time ? new Date(raw.ad_delivery_stop_time).getTime() : Date.now(); // still running
  const runtimeDays = startMs ? Math.max(0, Math.round((stopMs - startMs) / 86400000)) : null;

  return {
    source_ref: raw.id,
    source_url: raw.ad_snapshot_url || null,
    title: titles[0] || null,
    body: longestBody,
    cta: ctas[0] || null,
    visual_brief: null, // Meta doesn't expose creative text — only the snapshot URL
    language: Array.isArray(raw.languages) ? raw.languages[0] : null,
    region: regionHint,
    runtime_days: runtimeDays,
    page_id: raw.page_id || null,
    page_name: raw.page_name || null,
    publisher_platforms: Array.isArray(raw.publisher_platforms) ? raw.publisher_platforms : [],
    target_locations: raw.target_locations || null,
    ad_creation_time: raw.ad_creation_time || null,
    ad_delivery_start_time: raw.ad_delivery_start_time || null,
    ad_delivery_stop_time: raw.ad_delivery_stop_time || null,
  };
}

/**
 * Fetch ads by exact page name. Used for the expert-brand seeding pass —
 * pulls ads from specific gold-standard brands (Glossier, Liquid Death, etc.).
 */
async function fetchByPage({ pageName, region, limit = 25, token, _httpGetJSONOverride } = {}) {
  const key = token || process.env.META_AD_LIBRARY_TOKEN;
  if (!key) return { ok: false, reason: 'META_AD_LIBRARY_TOKEN not set', source: 'meta_ad_library' };
  if (!pageName) return { ok: false, reason: 'pageName required', source: 'meta_ad_library' };
  if (!region) return { ok: false, reason: 'region required', source: 'meta_ad_library' };
  if (META_AGGREGATE_REGIONS.has(region)) {
    return {
      ok: false,
      reason: `region must be a country code (got aggregate "${region}")`,
      source: 'meta_ad_library',
    };
  }
  const _get = _httpGetJSONOverride || _httpGetJSON;

  const url = _buildSearchUrl({
    token: key,
    searchTerms: pageName,
    adReachedCountries: region,
    limit,
  });
  const r = await _get(url);
  if (!r.ok || !r.json) {
    return {
      ok: false,
      source: 'meta_ad_library',
      status: r.status,
      reason: r.json?.error?.message || 'fetch failed',
    };
  }
  const rawAds = Array.isArray(r.json.data) ? r.json.data : [];
  // Filter to ads that actually match the page name (Meta sometimes returns
  // partial matches across unrelated pages)
  const ads = rawAds
    .filter((raw) => {
      const pn = (raw.page_name || '').toLowerCase();
      return pn.includes(pageName.toLowerCase().split(' ')[0]);
    })
    .map((raw) => normalizeAd(raw, region))
    .filter((a) => a.body && a.body.length > 20); // skip tiny ads (image-only)

  return {
    ok: true,
    source: 'meta_ad_library',
    ads,
    pageName,
    region,
  };
}

/**
 * Fetch ads by keyword search. Used for long-tail discovery — finds ads
 * mentioning industry terms across any page.
 */
async function fetchByKeyword({ keyword, region, limit = 50, token, _httpGetJSONOverride } = {}) {
  const key = token || process.env.META_AD_LIBRARY_TOKEN;
  if (!key) return { ok: false, reason: 'META_AD_LIBRARY_TOKEN not set', source: 'meta_ad_library' };
  if (!keyword) return { ok: false, reason: 'keyword required', source: 'meta_ad_library' };
  if (!region) return { ok: false, reason: 'region required', source: 'meta_ad_library' };
  if (META_AGGREGATE_REGIONS.has(region)) {
    return {
      ok: false,
      reason: `region must be a country code (got aggregate "${region}")`,
      source: 'meta_ad_library',
    };
  }
  const _get = _httpGetJSONOverride || _httpGetJSON;

  const url = _buildSearchUrl({
    token: key,
    searchTerms: keyword,
    adReachedCountries: region,
    limit,
  });
  const r = await _get(url);
  if (!r.ok || !r.json) {
    return {
      ok: false,
      source: 'meta_ad_library',
      status: r.status,
      reason: r.json?.error?.message || 'fetch failed',
    };
  }
  const rawAds = Array.isArray(r.json.data) ? r.json.data : [];
  const ads = rawAds.map((raw) => normalizeAd(raw, region)).filter((a) => a.body && a.body.length > 20);

  return {
    ok: true,
    source: 'meta_ad_library',
    ads,
    keyword,
    region,
  };
}

module.exports = {
  fetchByPage,
  fetchByKeyword,
  normalizeAd,
  _buildSearchUrl,
  META_AGGREGATE_REGIONS,
};
