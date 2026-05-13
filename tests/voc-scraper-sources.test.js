'use strict';

const test = require('node:test');
const assert = require('node:assert');

const googlePlaces = require('../services/voc-scraper/sources/google-places');
const yelp = require('../services/voc-scraper/sources/yelp');
const trustpilot = require('../services/voc-scraper/sources/trustpilot');
const manual = require('../services/voc-scraper/sources/manual');

// ─── Google Places ──────────────────────────────────────────────────────────

test('google-places: returns ok=false when API key missing', async () => {
  delete process.env.GOOGLE_PLACES_API_KEY;
  const r = await googlePlaces.fetch({ placeId: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /GOOGLE_PLACES_API_KEY/);
  assert.strictEqual(r.source, 'google_places');
});

test('google-places: requires placeId or businessName', async () => {
  const r = await googlePlaces.fetch({ apiKey: 'fake' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /placeId or businessName/);
});

test('google-places: fetches reviews via placeId', async () => {
  const mockHttp = async (url) => {
    if (url.includes('details/json')) {
      return {
        ok: true,
        status: 200,
        json: {
          result: {
            name: 'Test Cafe',
            rating: 4.8,
            user_ratings_total: 247,
            reviews: [
              { rating: 5, text: 'Best espresso in Tirana', author_name: 'Lila', time: 1700000000, language: 'sq' },
              { rating: 4, text: 'Cozy spot', author_name: 'Ed', time: 1700100000, language: 'en' },
            ],
          },
        },
      };
    }
    return { ok: false, status: 404 };
  };
  const r = await googlePlaces.fetch({
    placeId: 'ChIJTestPlaceId',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reviews.length, 2);
  assert.strictEqual(r.business_rating, 4.8);
  assert.strictEqual(r.review_count_total, 247);
  assert.match(r.reviews[0].text, /espresso/);
});

test('google-places: resolves placeId from businessName + city', async () => {
  let findCalled = false;
  const mockHttp = async (url) => {
    if (url.includes('findplacefromtext')) {
      findCalled = true;
      return {
        ok: true,
        status: 200,
        json: { candidates: [{ place_id: 'ChIJResolvedId', name: 'Test Cafe' }] },
      };
    }
    if (url.includes('details/json')) {
      assert.match(url, /ChIJResolvedId/);
      return {
        ok: true,
        status: 200,
        json: { result: { reviews: [{ rating: 5, text: 'Great', author_name: 'X', time: 1700000000 }] } },
      };
    }
    return { ok: false };
  };
  const r = await googlePlaces.fetch({
    businessName: 'Test Cafe',
    city: 'Tirana',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(findCalled, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.placeId, 'ChIJResolvedId');
});

test('google-places: returns no-match when find place returns empty', async () => {
  const mockHttp = async () => ({ ok: true, status: 200, json: { candidates: [] } });
  const r = await googlePlaces.fetch({
    businessName: 'Nonexistent',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no match/);
});

test('google-places: filters out reviews with empty text', async () => {
  const mockHttp = async () => ({
    ok: true,
    status: 200,
    json: {
      result: {
        reviews: [
          { rating: 5, text: 'Good', author_name: 'A', time: 1 },
          { rating: 5, text: '', author_name: 'B', time: 2 },
          { rating: 4, text: '   ', author_name: 'C', time: 3 },
        ],
      },
    },
  });
  const r = await googlePlaces.fetch({
    placeId: 'X',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.reviews.length, 1);
});

// ─── Yelp ───────────────────────────────────────────────────────────────────

test('yelp: returns ok=false when API key missing', async () => {
  delete process.env.YELP_API_KEY;
  const r = await yelp.fetch({ businessName: 'x' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /YELP_API_KEY/);
});

test('yelp: fetches reviews via businessId', async () => {
  const mockHttp = async (url) => {
    if (url.includes('/reviews')) {
      return {
        ok: true,
        status: 200,
        json: {
          total: 47,
          reviews: [
            { rating: 5, text: 'Excellent service and food.', user: { name: 'Maria' }, time_created: '2026-04-01' },
            { rating: 4, text: 'Good but a bit pricey.', user: { name: 'Lorenzo' }, time_created: '2026-03-15' },
          ],
        },
      };
    }
    return { ok: false };
  };
  const r = await yelp.fetch({
    businessId: 'yelp-id-123',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reviews.length, 2);
  assert.strictEqual(r.review_count_total, 47);
  assert.match(r.reviews[0].text, /Excellent/);
});

test('yelp: resolves businessId from name + city', async () => {
  let searchCalled = false;
  const mockHttp = async (url) => {
    if (url.includes('businesses/search')) {
      searchCalled = true;
      return {
        ok: true,
        status: 200,
        json: { businesses: [{ id: 'yelp-resolved-id', name: 'Test Cafe' }] },
      };
    }
    if (url.includes('/reviews')) {
      assert.match(url, /yelp-resolved-id/);
      return { ok: true, status: 200, json: { reviews: [{ rating: 5, text: 'good', user: { name: 'X' } }] } };
    }
    return { ok: false };
  };
  const r = await yelp.fetch({
    businessName: 'Test Cafe',
    city: 'Tirana',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(searchCalled, true);
  assert.strictEqual(r.yelpBusinessId, 'yelp-resolved-id');
});

// ─── Trustpilot ─────────────────────────────────────────────────────────────

test('trustpilot: silently no-ops when no API key (paid tier)', async () => {
  delete process.env.TRUSTPILOT_API_KEY;
  const r = await trustpilot.fetch({ domain: 'example.com' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /TRUSTPILOT_API_KEY/);
  assert.strictEqual(r.source, 'trustpilot');
});

test('trustpilot: fetches reviews via businessUnitId when key available', async () => {
  const mockHttp = async (url) => {
    if (url.includes('/reviews')) {
      return {
        ok: true,
        status: 200,
        json: {
          reviews: [{ stars: 5, text: 'Best service ever', consumer: { displayName: 'P' }, createdAt: '2026-04-01' }],
        },
      };
    }
    return { ok: false };
  };
  const r = await trustpilot.fetch({
    businessUnitId: 'tp-unit',
    apiKey: 'fake',
    _httpGetJSONOverride: mockHttp,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reviews.length, 1);
  assert.strictEqual(r.reviews[0].rating, 5);
});

// ─── Manual ─────────────────────────────────────────────────────────────────

test('manual: requires reviewsText', async () => {
  const r = await manual.fetch({});
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /reviewsText/);
});

test('manual: accepts string or array', async () => {
  const r1 = await manual.fetch({ reviewsText: 'one review block' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.reviews.length, 1);

  const r2 = await manual.fetch({ reviewsText: ['first', 'second', 'third'] });
  assert.strictEqual(r2.reviews.length, 3);
});

test('manual: tags reviews with label (own/competitor)', async () => {
  const r = await manual.fetch({ reviewsText: 'competitor review here', label: 'competitor' });
  assert.strictEqual(r.reviews[0].label, 'competitor');
});

test('manual: filters out empty strings', async () => {
  const r = await manual.fetch({ reviewsText: ['real review', '', '   '] });
  assert.strictEqual(r.reviews.length, 1);
});
