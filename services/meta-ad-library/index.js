'use strict';

/**
 * services/meta-ad-library/index.js
 * ---------------------------------------------------------------------------
 * Real Meta Ad Library client.
 *
 * Endpoint: GET https://graph.facebook.com/v21.0/ads_archive
 *
 * Auth: requires META_APP_ID + META_APP_SECRET (App Access Token). Public
 * API but rate-limited (200 calls/hour by default).
 *
 * Returns active competitor ads matching a search term in a country.
 *
 * Public API:
 *   isConfigured() → boolean
 *   search({ search_terms, country = 'US', limit = 50 })
 *     → array of normalized ad objects: [{ id, ad_creation_time,
 *         ad_creative_bodies, ad_creative_link_titles, page_name, audience? }]
 * ---------------------------------------------------------------------------
 */

const GRAPH_VERSION = 'v21.0';
const FIELDS = [
  'id',
  'ad_creation_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'page_id',
  'page_name',
  'publisher_platforms',
  'estimated_audience_size',
  'currency',
  'languages',
].join(',');

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

async function getAppAccessToken() {
  if (!isConfigured()) return null;
  // App Access Token = APP_ID|APP_SECRET (Meta's documented shorthand).
  // For Ad Library calls we can use this directly without an OAuth round trip.
  return `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
}

async function search({ search_terms, country = 'US', limit = 50 }) {
  const token = await getAppAccessToken();
  if (!token) return [];

  const params = new URLSearchParams({
    access_token: token,
    search_terms: String(search_terms || '').slice(0, 100),
    ad_reached_countries: `["${country}"]`,
    ad_active_status: 'ACTIVE',
    ad_type: 'POLITICAL_AND_ISSUE_ADS,ALL',
    fields: FIELDS,
    limit: String(Math.min(Math.max(1, limit), 100)),
  });

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/ads_archive?${params.toString()}`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) return [];

    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((row) => ({
      id: row.id,
      ad_creation_time: row.ad_creation_time,
      ad_delivery_start_time: row.ad_delivery_start_time,
      ad_delivery_stop_time: row.ad_delivery_stop_time,
      text: (row.ad_creative_bodies && row.ad_creative_bodies[0]) || '',
      headline: (row.ad_creative_link_titles && row.ad_creative_link_titles[0]) || '',
      description: (row.ad_creative_link_descriptions && row.ad_creative_link_descriptions[0]) || '',
      page_name: row.page_name,
      page_id: row.page_id,
      platforms: row.publisher_platforms || [],
      audience_size: row.estimated_audience_size || null,
      languages: row.languages || [],
      currency: row.currency,
      // Audience field not available from Ad Library directly — left null
      audience: null,
      // Stable URL for the ad in Meta's archive (UI deep-link)
      url: `https://www.facebook.com/ads/library/?id=${row.id}`,
    }));
  } catch (e) {
    return [];
  }
}

module.exports = { search, isConfigured };
