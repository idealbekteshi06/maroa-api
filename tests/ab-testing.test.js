'use strict';

const test = require('node:test');
const assert = require('node:assert');
const createAbTesting = require('../services/ab-testing');

const BIZ = '11111111-1111-4111-8111-111111111111';
const EXP = '22222222-2222-4222-8222-222222222222';
const CAMP_A = '33333333-3333-4333-8333-333333333333';
const CAMP_B = '44444444-4444-4444-8444-444444444444';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── Statistical core ──────────────────────────────────────────────────────

test('twoProportionZTest: known textbook case is significant', () => {
  const ab = createAbTesting({ logger: noopLogger });
  // A: 200/10000 = 2.0% CTR; B: 260/10000 = 2.6% CTR → z ≈ 2.79, p ≈ 0.005
  const r = ab.twoProportionZTest({ aSuccess: 200, aTrials: 10000, bSuccess: 260, bTrials: 10000 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.z > 2.5 && r.z < 3.1, `z=${r.z}`);
  assert.ok(r.pValue < 0.01, `p=${r.pValue}`);
  assert.ok(Math.abs(r.lift - 0.3) < 0.001, 'B lifts A by 30%');
});

test('twoProportionZTest: identical rates are not significant; zero/degenerate arms safe', () => {
  const ab = createAbTesting({ logger: noopLogger });
  const same = ab.twoProportionZTest({ aSuccess: 50, aTrials: 5000, bSuccess: 50, bTrials: 5000 });
  assert.ok(same.pValue > 0.9);
  const zero = ab.twoProportionZTest({ aSuccess: 0, aTrials: 1000, bSuccess: 0, bTrials: 1000 });
  assert.strictEqual(zero.pValue, 1, 'both-zero arms carry no signal');
  const none = ab.twoProportionZTest({ aSuccess: 0, aTrials: 0, bSuccess: 5, bTrials: 100 });
  assert.strictEqual(none.ok, false);
});

test('pValueTwoTailed: sanity anchors (z=1.96 → ~0.05, z=0 → 1)', () => {
  const ab = createAbTesting({ logger: noopLogger });
  assert.ok(Math.abs(ab.pValueTwoTailed(1.96) - 0.05) < 0.002);
  assert.ok(ab.pValueTwoTailed(0) > 0.999, 'z=0 → p≈1 (erf approximation)');
});

// ─── Engine behavior ───────────────────────────────────────────────────────

function makeDeps({ logsByCampaign = {}, experiment }) {
  const patches = [];
  return {
    patches,
    deps: {
      logger: noopLogger,
      sbGet: async (table, filter) => {
        if (table === 'ab_tests') return experiment ? [experiment] : [];
        if (table === 'ad_performance_logs') {
          for (const [camp, logs] of Object.entries(logsByCampaign)) {
            if (filter.includes(camp)) return logs;
          }
          return [];
        }
        return [];
      },
      sbPost: async (_t, row) => ({ id: EXP, ...row }),
      sbPatch: async (_t, _f, patch) => {
        patches.push(patch);
        return {};
      },
    },
  };
}

const baseExperiment = {
  id: EXP,
  business_id: BIZ,
  metric: 'ctr',
  min_impressions_per_arm: 1000,
  status: 'collecting',
  variant_a: { campaign_id: CAMP_A, label: 'Hook A' },
  variant_b: { campaign_id: CAMP_B, label: 'Hook B' },
  tested_at: new Date(Date.now() - 86400000).toISOString(),
};

test('createExperiment: validates variants and metric', async () => {
  const { deps } = makeDeps({});
  const ab = createAbTesting(deps);
  await assert.rejects(() => ab.createExperiment({ businessId: BIZ, variantA: {}, variantB: {} }), /campaign_id/);
  await assert.rejects(
    () =>
      ab.createExperiment({
        businessId: BIZ,
        metric: 'vibes',
        variantA: { campaign_id: CAMP_A },
        variantB: { campaign_id: CAMP_B },
      }),
    /metric/
  );
  const row = await ab.createExperiment({
    businessId: BIZ,
    variantA: { campaign_id: CAMP_A, label: 'A' },
    variantB: { campaign_id: CAMP_B, label: 'B' },
  });
  assert.strictEqual(row.status, 'collecting');
  assert.strictEqual(row.metric, 'ctr');
});

test('evaluateExperiment: under-sampled arms stay collecting with progress detail', async () => {
  const { deps } = makeDeps({
    experiment: baseExperiment,
    logsByCampaign: {
      [CAMP_A]: [{ impressions: 500, clicks: 10, conversions: 1 }],
      [CAMP_B]: [{ impressions: 2000, clicks: 60, conversions: 5 }],
    },
  });
  const ab = createAbTesting(deps);
  const r = await ab.evaluateExperiment({ experimentId: EXP, businessId: BIZ });
  assert.strictEqual(r.status, 'collecting');
  assert.ok(r.result.detail.includes('A: 500'));
});

test('evaluateExperiment: significant CTR difference declares winner_b and concludes', async () => {
  const { deps, patches } = makeDeps({
    experiment: baseExperiment,
    logsByCampaign: {
      [CAMP_A]: [{ impressions: 10000, clicks: 200, conversions: 10 }],
      [CAMP_B]: [{ impressions: 10000, clicks: 300, conversions: 15 }],
    },
  });
  const ab = createAbTesting(deps);
  const r = await ab.evaluateExperiment({ experimentId: EXP, businessId: BIZ });
  assert.strictEqual(r.status, 'winner_b');
  assert.ok(r.result.p_value < 0.05);
  assert.ok(r.result.recommendation.includes('Variant B'));
  const concluding = patches.find((p) => p.status === 'winner_b');
  assert.ok(concluding.concluded_at, 'conclusion timestamped');
  assert.strictEqual(concluding.winner, 'b');
});

test('evaluateExperiment: big samples with no real difference → no_difference (futility stop)', async () => {
  const { deps } = makeDeps({
    experiment: baseExperiment,
    logsByCampaign: {
      [CAMP_A]: [{ impressions: 4000, clicks: 80, conversions: 4 }],
      [CAMP_B]: [{ impressions: 4100, clicks: 84, conversions: 4 }],
    },
  });
  const ab = createAbTesting(deps);
  const r = await ab.evaluateExperiment({ experimentId: EXP, businessId: BIZ });
  assert.strictEqual(r.status, 'no_difference');
  assert.ok(r.result.recommendation.includes('No meaningful difference'));
});

test('evaluateExperiment: conversion_rate metric uses clicks as trials', async () => {
  const { deps } = makeDeps({
    experiment: { ...baseExperiment, metric: 'conversion_rate' },
    logsByCampaign: {
      // 5% vs 15% conversion per click on 1000 clicks each → decisive
      [CAMP_A]: [{ impressions: 20000, clicks: 1000, conversions: 50 }],
      [CAMP_B]: [{ impressions: 20000, clicks: 1000, conversions: 150 }],
    },
  });
  const ab = createAbTesting(deps);
  const r = await ab.evaluateExperiment({ experimentId: EXP, businessId: BIZ });
  assert.strictEqual(r.status, 'winner_b');
  assert.strictEqual(r.result.arm_a.trials, 1000);
  assert.strictEqual(r.result.arm_a.success, 50);
});

test('evaluateExperiment: concluded experiments are idempotent', async () => {
  const { deps, patches } = makeDeps({
    experiment: { ...baseExperiment, status: 'winner_a', result: { verdict: 'winner_a' }, confidence: 0.99 },
  });
  const ab = createAbTesting(deps);
  const r = await ab.evaluateExperiment({ experimentId: EXP, businessId: BIZ });
  assert.strictEqual(r.already_concluded, true);
  assert.strictEqual(patches.length, 0, 'no re-patch of a concluded experiment');
});
