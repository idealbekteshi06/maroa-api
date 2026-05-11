'use strict';

const test = require('node:test');
const assert = require('node:assert');

const measurementHealth = require('../services/measurement-health');
const creativeEngine = require('../services/creative-engine');
const googleAds = require('../services/google-ads');
const tiktokAds = require('../services/tiktok-ads');
const interlock = require('../services/ad-optimizer/learning-phase-interlock');

// ─── Measurement Health — verdict logic ──────────────────────────────────

test('measurement-health: Meta verdict healthy when EMQ≥8 and dedup≥0.7', () => {
  const v = measurementHealth.deriveMetaVerdict({ emq: 8.5, dedup: 0.85 });
  assert.strictEqual(v.verdict, 'healthy');
  assert.strictEqual(v.trust, true);
  assert.deepStrictEqual(v.reasons, []);
});

test('measurement-health: Meta verdict degraded when EMQ between 6-8', () => {
  const v = measurementHealth.deriveMetaVerdict({ emq: 7.0, dedup: 0.75 });
  assert.strictEqual(v.verdict, 'degraded');
  assert.strictEqual(v.trust, true);
});

test('measurement-health: Meta verdict broken when EMQ<6', () => {
  const v = measurementHealth.deriveMetaVerdict({ emq: 4.5, dedup: 0.85 });
  assert.strictEqual(v.verdict, 'broken');
  assert.strictEqual(v.trust, false);
  assert.ok(v.reasons.some((r) => /EMQ/.test(r)));
});

test('measurement-health: Meta verdict broken when dedup<0.7', () => {
  const v = measurementHealth.deriveMetaVerdict({ emq: 9, dedup: 0.5 });
  assert.strictEqual(v.verdict, 'broken');
  assert.strictEqual(v.trust, false);
  assert.ok(v.reasons.some((r) => /dedup/.test(r)));
});

test('measurement-health: Google verdict broken when EC off', () => {
  const v = measurementHealth.deriveGoogleVerdict({
    enhancedOn: false,
    matchRate: 0.8,
    convActionCount: 1,
  });
  assert.strictEqual(v.verdict, 'broken');
  assert.ok(v.reasons.some((r) => /Enhanced Conversions OFF/.test(r)));
});

test('measurement-health: Google verdict healthy when EC on + match rate >=0.7', () => {
  const v = measurementHealth.deriveGoogleVerdict({
    enhancedOn: true,
    matchRate: 0.8,
    convActionCount: 1,
  });
  assert.strictEqual(v.verdict, 'healthy');
  assert.strictEqual(v.trust, true);
});

test('measurement-health: TikTok verdict broken when 0 events in 24h', () => {
  const v = measurementHealth.deriveTikTokVerdict({
    eventsApiHealth: 'ok',
    events24h: 0,
  });
  assert.strictEqual(v.verdict, 'broken');
});

// ─── Creative Engine — z-score + bucketing ───────────────────────────────

test('creative-engine: meanStd handles edge cases', () => {
  assert.deepStrictEqual(creativeEngine.meanStd([]), { mean: 0, std: 0, n: 0 });
  const single = creativeEngine.meanStd([5]);
  assert.strictEqual(single.mean, 5);
  assert.strictEqual(single.std, 0);
  assert.strictEqual(single.n, 1);
});

test('creative-engine: meanStd produces correct stats', () => {
  const r = creativeEngine.meanStd([1, 2, 3, 4, 5]);
  assert.strictEqual(r.mean, 3);
  assert.ok(Math.abs(r.std - 1.5811) < 0.01); // sample std
  assert.strictEqual(r.n, 5);
});

test('creative-engine: zScore returns 0 on degenerate input', () => {
  assert.strictEqual(creativeEngine.zScore(5, 5, 0), 0);
  assert.strictEqual(creativeEngine.zScore(NaN, 5, 1), 0);
});

test('creative-engine: zScore computes correctly', () => {
  assert.strictEqual(creativeEngine.zScore(7, 5, 1), 2); // 2 std above
  assert.strictEqual(creativeEngine.zScore(3, 5, 1), -2); // 2 std below
});

test('creative-engine: bucketBudgetTier maps daily budget correctly', () => {
  assert.strictEqual(creativeEngine.bucketBudgetTier(5), '5');
  assert.strictEqual(creativeEngine.bucketBudgetTier(15), '5');
  assert.strictEqual(creativeEngine.bucketBudgetTier(25), '20');
  assert.strictEqual(creativeEngine.bucketBudgetTier(50), '50');
  assert.strictEqual(creativeEngine.bucketBudgetTier(100), '100');
  assert.strictEqual(creativeEngine.bucketBudgetTier(1000), '500');
});

test('creative-engine: VARIANTS_PER_DAY enforces plan tier', () => {
  assert.strictEqual(creativeEngine.VARIANTS_PER_DAY_BY_PLAN.free, 0);
  assert.strictEqual(creativeEngine.VARIANTS_PER_DAY_BY_PLAN.growth, 3);
  assert.strictEqual(creativeEngine.VARIANTS_PER_DAY_BY_PLAN.agency, 5);
});

// ─── Google Ads — Power Pack + asset coverage + consolidation ────────────

test('google-ads: recommendAllocation defaults to Power Pack with no data', () => {
  const r = googleAds.recommendAllocation({});
  assert.strictEqual(r.allocation.pmax, 0.7);
  assert.strictEqual(r.allocation.ai_max_search, 0.2);
  assert.strictEqual(r.allocation.demand_gen, 0.1);
});

test('google-ads: recommendAllocation shifts toward over-performer', () => {
  const r = googleAds.recommendAllocation({
    currentSplit: { pmax: 0.7, ai_max_search: 0.2, demand_gen: 0.1 },
    roasByType: { pmax: 5.0, ai_max_search: 1.0, demand_gen: 1.0 }, // PMax 5× others
  });
  assert.ok(r.allocation.pmax > 0.7, `Expected PMax to grow, got ${r.allocation.pmax}`);
  assert.ok(r.reasons.some((reason) => /pmax/.test(reason)));
});

test('google-ads: recommendAllocation respects learning-phase types', () => {
  const r = googleAds.recommendAllocation({
    currentSplit: { pmax: 0.7, ai_max_search: 0.2, demand_gen: 0.1 },
    roasByType: { pmax: 5.0, ai_max_search: 0.1, demand_gen: 1.0 },
    learningPhaseTypes: ['ai_max_search'], // can't drain from learning campaigns
  });
  // ai_max_search ROAS is in the data but excluded from movable list.
  // PMax should still grow (we should detect over-performance among movables).
  assert.ok(r.allocation.demand_gen <= 0.1, 'demand_gen should not grow');
});

test('google-ads: scoreAssetCoverage flags <60% video coverage', () => {
  const r = googleAds.scoreAssetCoverage([{ videos: [{ id: 'v1' }] }, { videos: [] }, { videos: [] }]);
  assert.ok(r.score < 60, `Expected score < 60 with only 1/3 having video, got ${r.score}`);
  assert.ok(r.recommendations.some((rec) => /Video coverage/.test(rec)));
});

test('google-ads: scoreAssetCoverage clean when ≥60% coverage', () => {
  const r = googleAds.scoreAssetCoverage([{ videos: [{ id: 'v1' }] }, { videos: [{ id: 'v2' }] }, { videos: [] }]);
  assert.ok(r.score >= 60);
  assert.strictEqual(r.recommendations.length, 0);
});

test('google-ads: shouldConsolidate refuses below 30 conversions/month', () => {
  const r = googleAds.shouldConsolidate({
    campaignsOfType: [{ type: 'pmax' }, { type: 'pmax' }],
    monthlyConversions: 25,
  });
  assert.strictEqual(r.consolidate, false);
  assert.ok(r.reason.includes('25'));
});

test('google-ads: shouldConsolidate allows at 30+ conversions/month', () => {
  const r = googleAds.shouldConsolidate({
    campaignsOfType: [{ type: 'pmax' }, { type: 'pmax' }],
    monthlyConversions: 50,
  });
  assert.strictEqual(r.consolidate, true);
});

test('google-ads: decideForCampaign holds during learning phase', () => {
  const r = googleAds.decideForCampaign({
    camp: { id: 'c1', type: 'pmax', learning_phase: true, roas: 5.0 },
    trustScaling: true,
  });
  assert.strictEqual(r.decision, 'hold');
});

test('google-ads: decideForCampaign refuses scaling with broken measurement', () => {
  const r = googleAds.decideForCampaign({
    camp: { id: 'c1', type: 'pmax', learning_phase: false, roas: 5.0, conversions_30d: 100 },
    trustScaling: false,
  });
  assert.strictEqual(r.decision, 'hold');
  assert.ok(/untrusted/.test(r.reason));
});

// ─── TikTok Ads — eligibility + Spark Ads selection ──────────────────────

test('tiktok-ads: ineligible below $50/day', () => {
  assert.strictEqual(tiktokAds.isEligible({ dailyBudget: 30 }), false);
  assert.strictEqual(tiktokAds.isEligible({ dailyBudget: 49 }), false);
  assert.strictEqual(tiktokAds.isEligible({ dailyBudget: 50 }), true);
  assert.strictEqual(tiktokAds.isEligible({ dailyBudget: 100 }), true);
});

test('tiktok-ads: eligibilityVerdict explains rejection', () => {
  const v = tiktokAds.eligibilityVerdict({ dailyBudget: 30, businessVerified: true });
  assert.strictEqual(v.eligible, false);
  assert.ok(v.reasons.some((r) => r.includes('$50')));
});

test('tiktok-ads: decideForTikTokCampaign holds during learning', () => {
  const r = tiktokAds.decideForTikTokCampaign({
    camp: { id: 't1', in_learning: true, roas: 5.0 },
    trust: true,
  });
  assert.strictEqual(r.decision, 'hold');
});

test('tiktok-ads: decideForTikTokCampaign requests refresh on low ROAS', () => {
  const r = tiktokAds.decideForTikTokCampaign({
    camp: { id: 't1', in_learning: false, roas: 0.5, conversions_30d: 20 },
    trust: true,
  });
  assert.strictEqual(r.decision, 'refresh_creative');
});

// ─── Learning-phase interlock ────────────────────────────────────────────

test('interlock: caps budget changes during learning phase', () => {
  const r = interlock.canAdjustBudget({
    adSet: { in_learning_phase: true, exited_learning_at: null, daily_budget: 50 },
    proposedDelta: 0.5, // +50%
  });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.capped_to, 0.2);
  assert.ok(/learning phase/.test(r.reason));
});

test('interlock: caps budget changes during 72h cooldown', () => {
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
  const r = interlock.canAdjustBudget({
    adSet: { in_learning_phase: false, exited_learning_at: recent, daily_budget: 50 },
    proposedDelta: 0.3,
  });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.capped_to, 0.2);
  assert.ok(/cooldown/.test(r.reason));
});

test('interlock: full scaling allowed past 72h cooldown', () => {
  const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(); // 4 days ago
  const r = interlock.canAdjustBudget({
    adSet: { in_learning_phase: false, exited_learning_at: old, daily_budget: 50 },
    proposedDelta: 0.5,
  });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.capped_to, undefined);
});

test('interlock: refuses structural edits during learning', () => {
  const r = interlock.canEditStructure({
    adSet: { in_learning_phase: true },
  });
  assert.strictEqual(r.allowed, false);
  assert.ok(/reset learning/.test(r.reason));
});

test('interlock: refuses structural edits during 72h cooldown', () => {
  const recent = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const r = interlock.canEditStructure({
    adSet: { in_learning_phase: false, exited_learning_at: recent },
  });
  assert.strictEqual(r.allowed, false);
});

test('interlock: allows structural edits past 72h cooldown', () => {
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const r = interlock.canEditStructure({
    adSet: { in_learning_phase: false, exited_learning_at: old },
  });
  assert.strictEqual(r.allowed, true);
});
