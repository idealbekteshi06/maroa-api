'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildGroundingContext, fetchCompetitorWinningAds } = require('../lib/groundingContext');

const BIZ = '11111111-1111-4111-8111-111111111111';
const DAY = 86400000;

function snapshotRow(competitor, ads) {
  return { competitor_name: competitor, signal_payload: { ads_snapshot: ads }, observed_at: new Date().toISOString() };
}

function ad({ id, days, active = true, headline = 'Big Sale', text = 'Proven ad copy with specifics.' }) {
  const now = Date.now();
  return {
    id,
    headline,
    text,
    ad_delivery_start_time: new Date(now - days * DAY).toISOString(),
    ad_delivery_stop_time: active ? null : new Date(now - DAY).toISOString(),
  };
}

test('fetchCompetitorWinningAds: dedupes, ranks by longevity with active boost, caps at limit', async () => {
  const sbGet = async (table) =>
    table === 'competitor_signals'
      ? [
          snapshotRow('Acme', [ad({ id: '1', days: 90 }), ad({ id: '2', days: 5 }), ad({ id: '1', days: 90 })]),
          snapshotRow('Rival', [ad({ id: '3', days: 200, active: false }), ad({ id: '4', days: 30 })]),
        ]
      : [];
  const ads = await fetchCompetitorWinningAds({ sbGet, businessId: BIZ, limit: 3 });
  assert.strictEqual(ads.length, 3, 'capped + deduped (4 unique, limit 3)');
  assert.deepStrictEqual(
    ads.map((a) => a.runtime_days),
    [199, 90, 30],
    'longevity order (199d inactive still beats 90d*1.25 active; stop-yesterday trims a day)'
  );
  assert.strictEqual(ads[0].competitor, 'Rival');
  assert.strictEqual(ads[0].is_active, false);
});

test('fetchCompetitorWinningAds: empty/missing data never throws', async () => {
  assert.deepStrictEqual(await fetchCompetitorWinningAds({ sbGet: async () => [], businessId: BIZ }), []);
  assert.deepStrictEqual(
    await fetchCompetitorWinningAds({
      sbGet: async () => {
        throw new Error('db down');
      },
      businessId: BIZ,
    }),
    []
  );
  assert.deepStrictEqual(await fetchCompetitorWinningAds({ sbGet: null, businessId: BIZ }), []);
});

test('buildGroundingContext: ad_copy surface renders the winning-ads block with no-copy guardrail', async () => {
  const sbGet = async (table) => {
    if (table === 'competitor_signals') return [snapshotRow('Acme', [ad({ id: '1', days: 120 })])];
    if (table === 'businesses') return [{ id: BIZ, plan: 'growth', industry: 'retail' }];
    return [];
  };
  const ctx = await buildGroundingContext({ sbGet, businessId: BIZ, surface: 'ad_copy' });
  assert.ok(Array.isArray(ctx.competitorWinningAds));
  assert.strictEqual(ctx.competitorWinningAds.length, 1);
  const block = ctx.toPromptBlock();
  assert.ok(block.includes('Competitor ads running right now'), 'section header present');
  assert.ok(block.includes('120d'), 'runtime surfaced');
  assert.ok(/NEVER copy brand names/.test(block), 'anti-plagiarism guardrail present');
});

test('buildGroundingContext: non-ad surfaces skip the competitor fetch entirely', async () => {
  let touchedSignals = false;
  const sbGet = async (table) => {
    if (table === 'competitor_signals') touchedSignals = true;
    return [];
  };
  const ctx = await buildGroundingContext({ sbGet, businessId: BIZ, surface: 'email' });
  assert.strictEqual(touchedSignals, false, 'no competitor_signals query for email surface');
  assert.deepStrictEqual(ctx.competitorWinningAds, []);
});
