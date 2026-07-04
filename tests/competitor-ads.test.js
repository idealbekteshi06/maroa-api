'use strict';

const test = require('node:test');
const assert = require('node:assert');
const createCompetitorAds = require('../services/competitor-ads');

const BIZ = '11111111-1111-4111-8111-111111111111';
const DAY = 86400000;

function libAd({
  id,
  page,
  days,
  active = true,
  text = 'This ad has substantial marketing copy in it for sure.',
  headline = 'Big Sale',
}) {
  const now = Date.now();
  return {
    id,
    page_name: page,
    text,
    headline,
    platforms: ['facebook'],
    url: `https://www.facebook.com/ads/library/?id=${id}`,
    ad_delivery_start_time: new Date(now - days * DAY).toISOString(),
    ad_delivery_stop_time: active ? null : new Date(now - DAY).toISOString(),
  };
}

test('findWinningAds: ranks by longevity with active bonus, filters fuzzy page matches', async () => {
  const ca = createCompetitorAds({
    metaAdLibrary: {
      search: async () => [
        libAd({ id: '1', page: 'Acme Co', days: 90 }),
        libAd({ id: '2', page: 'Acme Co', days: 10 }),
        libAd({ id: '3', page: 'Acme Co', days: 200, active: false }),
        libAd({ id: '4', page: 'Totally Different Brand', days: 400 }), // fuzzy noise — dropped
      ],
    },
    sbGet: async () => [{ competitors: ['Acme Co'], country_code: 'US' }],
  });
  const r = await ca.findWinningAds({ businessId: BIZ });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    r.ads.map((a) => a.id),
    ['3', '1', '2'],
    'inactive 200d beats active 90d (200 > 90*1.25); noise page dropped'
  );
  assert.strictEqual(r.ads[1].is_active, true);
  assert.ok(r.ads[1].winner_score > r.ads[2].winner_score);
});

test('findWinningAds: explicit competitor name skips business lookup; caps limit', async () => {
  let searched;
  const ca = createCompetitorAds({
    metaAdLibrary: {
      search: async (opts) => {
        searched = opts;
        return Array.from({ length: 40 }, (_, i) => libAd({ id: String(i), page: 'Rival Inc', days: i + 1 }));
      },
    },
  });
  const r = await ca.findWinningAds({ competitorName: 'Rival Inc', country: 'DE', limit: 999 });
  assert.strictEqual(searched.country, 'DE');
  assert.strictEqual(r.ads.length, 25, 'hard cap at 25');
  assert.strictEqual(r.scanned, 40);
});

test('findWinningAds: no competitors configured → empty ok result', async () => {
  const ca = createCompetitorAds({
    metaAdLibrary: { search: async () => [] },
    sbGet: async () => [{ competitors: [] }],
  });
  const r = await ca.findWinningAds({ businessId: BIZ });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ads, []);
  assert.strictEqual(r.reason, 'no_competitors_configured');
});

test('buildRecreationBrief: borrows structure, forbids verbatim copying, names the business', () => {
  const ca = createCompetitorAds({ metaAdLibrary: { search: async () => [] } });
  const brief = ca.buildRecreationBrief({
    ad: { headline: '50% Off Everything', text: 'Shop the sale now', runtime_days: 120, is_active: true },
    business: { business_name: 'ibgboost' },
  });
  assert.ok(brief.includes('ibgboost'));
  assert.ok(brief.includes('120 days'));
  assert.ok(brief.includes('still running'));
  assert.ok(brief.includes('50% Off Everything'));
  assert.ok(/Do not copy their brand name/.test(brief));
});
