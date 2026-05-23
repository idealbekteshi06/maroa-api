'use strict';

/**
 * Optional Google Business Profile snapshot via Places API (New).
 * Requires GOOGLE_PLACES_API_KEY. Returns null when unset — caller uses manual auditInput.
 */

const https = require('https');

function placesGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'displayName,rating,userRatingCount,websiteUri,formattedAddress,types',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Places API timeout')));
    req.end();
  });
}

/**
 * @param {{ placeId?: string, businessName?: string, city?: string }} opts
 * @returns {Promise<object|null>}
 */
async function fetchGbpSnapshot(opts = {}) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!apiKey) return null;

  if (opts.placeId) {
    const detail = await placesGet(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(opts.placeId)}`,
      apiKey
    );
    if (!detail) return null;
    return {
      source: 'google_places',
      name: detail.displayName?.text || opts.businessName,
      rating: detail.rating,
      reviewCount: detail.userRatingCount,
      website: detail.websiteUri,
      address: detail.formattedAddress,
      categories: detail.types || [],
    };
  }

  const query = [opts.businessName, opts.city].filter(Boolean).join(' ');
  if (!query) return null;

  const searchBody = JSON.stringify({ textQuery: query });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'places.googleapis.com',
        path: '/v1/places:searchText',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(searchBody),
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress,places.types',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const p = parsed.places?.[0];
            if (!p) return resolve(null);
            resolve({
              source: 'google_places_search',
              name: p.displayName?.text,
              rating: p.rating,
              reviewCount: p.userRatingCount,
              website: p.websiteUri,
              address: p.formattedAddress,
              categories: p.types || [],
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(searchBody);
    req.end();
  });
}

module.exports = { fetchGbpSnapshot };
