'use strict';

const test = require('node:test');
const assert = require('node:assert');

const metaAdLib = require('../services/public-pretrainer/sources/meta-ad-library');
const placesCohort = require('../services/public-pretrainer/sources/google-places-cohort');

// ─── Meta Ad Library ───────────────────────────────────────────────────────

test('meta-ad-library: returns ok=false without token', async () => {
  const prev = process.env.META_AD_LIBRARY_TOKEN;
  delete process.env.META_AD_LIBRARY_TOKEN;
  const r = await metaAdLib.fetchByPage({ pageName: 'X', region: 'US' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /META_AD_LIBRARY_TOKEN/);
  if (prev) process.env.META_AD_LIBRARY_TOKEN = prev;
});

test('meta-ad-library: rejects aggregate regions (must be country code)', async () => {
  const r = await metaAdLib.fetchByPage({ pageName: 'X', region: 'EU', token: 'fake' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /aggregate/);
});

test('meta-ad-library: requires pageName + region', async () => {
  const r1 = await metaAdLib.fetchByPage({ region: 'US', token: 'fake' });
  assert.match(r1.reason, /pageName/);
  const r2 = await metaAdLib.fetchByPage({ pageName: 'X', token: 'fake' });
  assert.match(r2.reason, /region/);
});

test('meta-ad-library: fetchByPage filters by page name + normalizes ads', async () => {
  const mockHttp = async () => ({
    ok: true,
    status: 200,
    json: {
      data: [
        {
          id: '123',
          ad_creative_bodies: ['Try the Pumpkin Latte for $5 today only at Starbucks'],
          ad_creative_link_titles: ['New Fall Menu'],
          ad_creative_link_captions: ['Order Now'],
          ad_delivery_start_time: '2026-01-01',
          page_name: 'Starbucks',
          page_id: 'sb1',
          languages: ['en'],
          publisher_platforms: ['facebook', 'instagram'],
        },
        {
          id: '456',
          ad_creative_bodies: ['Unrelated ad from a different brand'],
          page_name: 'Unrelated Brand',
        },
      ],
    },
  });
  const r = await metaAdLib.fetchByPage({
    pageName: 'Starbucks',
    region: 'US',
    token: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  // Only Starbucks ad should pass the page-name filter
  assert.strictEqual(r.ads.length, 1);
  assert.match(r.ads[0].body, /Pumpkin Latte/);
  assert.strictEqual(r.ads[0].page_name, 'Starbucks');
  assert.strictEqual(r.ads[0].region, 'US');
});

test('meta-ad-library: drops short / empty body ads (image-only)', async () => {
  const mockHttp = async () => ({
    ok: true,
    status: 200,
    json: {
      data: [
        { id: '1', ad_creative_bodies: ['short'], page_name: 'X' },
        { id: '2', ad_creative_bodies: [], page_name: 'X' },
        {
          id: '3',
          ad_creative_bodies: ['This is a proper ad with enough text to score a real body length signal'],
          page_name: 'X',
        },
      ],
    },
  });
  const r = await metaAdLib.fetchByPage({
    pageName: 'X',
    region: 'US',
    token: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ads.length, 1);
});

test('meta-ad-library: fetchByKeyword works without page filter', async () => {
  const mockHttp = async () => ({
    ok: true,
    status: 200,
    json: {
      data: [
        {
          id: '789',
          ad_creative_bodies: ['Best cafe in town, fresh espresso, friendly staff'],
          page_name: 'Random Cafe',
          languages: ['en'],
        },
      ],
    },
  });
  const r = await metaAdLib.fetchByKeyword({
    keyword: 'cafe marketing',
    region: 'US',
    token: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ads.length, 1);
  assert.strictEqual(r.ads[0].page_name, 'Random Cafe');
});

test('meta-ad-library: normalizeAd computes runtime_days', () => {
  const start = new Date('2026-04-01').toISOString();
  const stop = new Date('2026-05-01').toISOString();
  const normalized = metaAdLib.normalizeAd(
    {
      id: 'X',
      ad_creative_bodies: ['Ad body'],
      ad_delivery_start_time: start,
      ad_delivery_stop_time: stop,
    },
    'US'
  );
  assert.strictEqual(normalized.runtime_days, 30);
});

// ─── Google Places cohort ──────────────────────────────────────────────────

test('places-cohort: returns ok=false without API key', async () => {
  const prev = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  const r = await placesCohort.fetch({ industryKeyword: 'cafe', regionLabel: 'Tirana' });
  assert.strictEqual(r.ok, false);
  if (prev) process.env.GOOGLE_PLACES_API_KEY = prev;
});

test('places-cohort: fetches top businesses then reviews', async () => {
  let calls = 0;
  const mockHttp = async (url) => {
    calls++;
    if (url.includes('textsearch')) {
      return {
        ok: true,
        status: 200,
        json: {
          results: [
            { place_id: 'p1', name: 'Best Cafe', rating: 4.8, user_ratings_total: 100 },
            { place_id: 'p2', name: 'OK Cafe', rating: 4.2, user_ratings_total: 50 },
            { place_id: 'p3', name: 'Bad Cafe', rating: 3.5, user_ratings_total: 10 }, // filtered out (<4.0)
          ],
        },
      };
    }
    if (url.includes('details')) {
      return {
        ok: true,
        status: 200,
        json: {
          result: {
            reviews: [
              {
                rating: 5,
                text: 'Amazing coffee, will return!',
                author_name: 'Lila',
                time: 1700000000,
                language: 'sq',
              },
            ],
          },
        },
      };
    }
    return { ok: false };
  };
  const r = await placesCohort.fetch({
    industryKeyword: 'cafe',
    regionLabel: 'Tirana, Albania',
    regionCode: 'AL',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  // 2 businesses (p3 filtered out), 1 review each
  assert.strictEqual(r.reviews.length, 2);
  assert.strictEqual(r.reviews[0].business_name, 'Best Cafe');
  assert.strictEqual(r.reviews[0].region, 'AL');
});

test('places-cohort: returns empty reviews when no businesses match', async () => {
  const mockHttp = async () => ({ ok: true, status: 200, json: { results: [] } });
  const r = await placesCohort.fetch({
    industryKeyword: 'unicorn',
    regionLabel: 'Atlantis',
    regionCode: 'ZZ',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reviews.length, 0);
});
