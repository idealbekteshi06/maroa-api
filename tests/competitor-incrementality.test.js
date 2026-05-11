'use strict';

const test = require('node:test');
const assert = require('node:assert');

const competitor = require('../services/competitor-watch');
const incr = require('../services/forecasting/incrementality');

// ─── Competitor Watch ─────────────────────────────────────────────────────

test('competitor: detectChanges flags new ads (in after, not before)', () => {
  const before = [{ id: 'a1', text: 'old' }];
  const after = [
    { id: 'a1', text: 'old' },
    { id: 'a2', text: 'new' },
  ];
  const changes = competitor.detectChanges({ before, after, source: 'meta_ad_library' });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].signal_type, 'new_ad_launched');
  assert.strictEqual(changes[0].payload.ad.id, 'a2');
});

test('competitor: detectChanges flags paused ads (in before, not after)', () => {
  const before = [{ id: 'a1' }, { id: 'a2' }];
  const after = [{ id: 'a1' }];
  const changes = competitor.detectChanges({ before, after, source: 'meta_ad_library' });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].signal_type, 'ad_paused');
  assert.strictEqual(changes[0].payload.ad.id, 'a2');
});

test('competitor: detectChanges returns empty when no changes', () => {
  const ads = [{ id: 'a1' }, { id: 'a2' }];
  const changes = competitor.detectChanges({ before: ads, after: ads, source: 'meta_ad_library' });
  assert.strictEqual(changes.length, 0);
});

test('competitor: classifyChange escalates new ad to alert when audience overlaps >60%', () => {
  const change = {
    signal_type: 'new_ad_launched',
    source: 'meta_ad_library',
    payload: { ad: { id: 'a1', audience: ['fitness', 'wellness', 'yoga', 'pilates'] } },
  };
  // 3/4 = 0.75 overlap → above 0.6 threshold
  const r = competitor.classifyChange(change, { ourTopAudience: ['fitness', 'wellness', 'yoga'] });
  assert.strictEqual(r.severity, 'alert');
  assert.ok(r.confidence > 0.5);
});

test('competitor: classifyChange returns watch for new ad without audience overlap', () => {
  const change = {
    signal_type: 'new_ad_launched',
    source: 'meta_ad_library',
    payload: { ad: { id: 'a1', audience: ['cars', 'racing'] } },
  };
  const r = competitor.classifyChange(change, { ourTopAudience: ['fitness'] });
  assert.strictEqual(r.severity, 'watch');
});

test('competitor: classifyChange marks spend_increase >= 50% WoW as alert', () => {
  const r = competitor.classifyChange({
    signal_type: 'spend_increase',
    payload: { spend_delta_pct: 0.75 },
  });
  assert.strictEqual(r.severity, 'alert');
});

test('competitor: classifyChange marks spend_increase < 50% as info', () => {
  const r = competitor.classifyChange({
    signal_type: 'spend_increase',
    payload: { spend_delta_pct: 0.2 },
  });
  assert.strictEqual(r.severity, 'info');
});

test('competitor: classifyChange marks 30%+ keyword overlap as critical', () => {
  const r = competitor.classifyChange({
    signal_type: 'keyword_overlap',
    payload: { overlap_pct: 0.45 },
  });
  assert.strictEqual(r.severity, 'critical');
});

test('competitor: audienceOverlap handles arrays of strings', () => {
  assert.strictEqual(competitor.audienceOverlap(['a', 'b', 'c'], ['b', 'c', 'd']), 2 / 3);
  assert.strictEqual(competitor.audienceOverlap(['a'], ['b']), 0);
  assert.strictEqual(competitor.audienceOverlap([], ['b']), 0);
});

// ─── Incrementality Engine ────────────────────────────────────────────────

test('incrementality: designTest splits geos by smallest-first', () => {
  const r = incr.designTest({
    allGeos: [
      { name: 'NYC', weight: 100 },
      { name: 'LA', weight: 80 },
      { name: 'Chicago', weight: 60 },
      { name: 'Houston', weight: 40 },
      { name: 'Phoenix', weight: 20 },
    ],
    holdoutPct: 0.1,
  });
  assert.strictEqual(r.ok, true);
  // Total weight 300, target 10% = 30. Phoenix (20) alone is below target,
  // so we add Houston (40) to reach 60. Smallest-first keeps the largest
  // geos in treatment for max scale.
  assert.ok(r.control_geos.includes('Phoenix'), 'Phoenix should be in control (smallest)');
  assert.ok(r.control_geos.length >= 1 && r.control_geos.length <= 2);
  assert.ok(!r.control_geos.includes('NYC'), 'NYC should never be control');
  assert.strictEqual(r.recommended_duration_days, 14);
});

test('incrementality: designTest refuses < 4 geos', () => {
  const r = incr.designTest({ allGeos: ['NYC', 'LA', 'Chicago'] });
  assert.strictEqual(r.ok, false);
  assert.ok(/4 distinct geos/.test(r.reason));
});

test('incrementality: twoProportionZTest detects significant difference', () => {
  // 100/1000 vs 50/1000 → big difference, p should be very small
  const r = incr.twoProportionZTest({ x1: 100, n1: 1000, x2: 50, n2: 1000 });
  assert.ok(r.z > 0);
  assert.ok(r.p_two_sided < 0.001);
});

test('incrementality: twoProportionZTest returns p≈1 for identical rates', () => {
  const r = incr.twoProportionZTest({ x1: 50, n1: 1000, x2: 50, n2: 1000 });
  assert.strictEqual(Math.abs(r.z), 0);
  // CDF approximation is accurate to ~1e-7, so allow tiny rounding.
  assert.ok(Math.abs(r.p_two_sided - 1) < 1e-6, `Expected p≈1, got ${r.p_two_sided}`);
});

test('incrementality: analyzeResults marks inconclusive when treatment <30 conversions', () => {
  const r = incr.analyzeResults({
    test: { id: 't1' },
    observations: {
      treatment: { conversions: 25, spend: 1000, audience_size: 1000, aov: 50 },
      control: { conversions: 5, spend: 0, audience_size: 100, aov: 50 },
    },
  });
  assert.strictEqual(r.status, 'inconclusive');
});

test('incrementality: analyzeResults computes lift + true ROAS when significant', () => {
  // Treatment audience 9000, 900 conversions ($50 AOV, $5000 spend)
  // Control audience 1000, 50 conversions
  // Per-capita: treatment 0.10 vs control 0.05 → 100% lift
  // Incremental conversions = 900 - 50*9 = 450
  // True ROAS = 450 * 50 / 5000 = 4.5
  const r = incr.analyzeResults({
    test: { id: 't1' },
    observations: {
      treatment: { conversions: 900, spend: 5000, audience_size: 9000, aov: 50 },
      control: { conversions: 50, spend: 0, audience_size: 1000, aov: 50 },
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'completed');
  assert.ok(Math.abs(r.incremental_lift_pct - 1.0) < 0.01, `Expected ~100% lift, got ${r.incremental_lift_pct}`);
  assert.ok(Math.abs(r.true_incremental_roas - 4.5) < 0.01, `Expected ~4.5 ROAS, got ${r.true_incremental_roas}`);
  assert.strictEqual(r.is_statistically_significant, true);
});

test('incrementality: analyzeResults shows platform-claimed > true incremental ROAS', () => {
  // Common case: platform ROAS over-counts because it credits conversions
  // that would have happened anyway.
  // Treatment 200 conv ($50 AOV, $1000 spend) → platform ROAS 10
  // Control says conversion rate is half — so half is incremental → true ROAS 5
  const r = incr.analyzeResults({
    test: { id: 't1' },
    observations: {
      treatment: { conversions: 200, spend: 1000, audience_size: 2000, aov: 50 },
      control: { conversions: 100, spend: 0, audience_size: 2000, aov: 50 },
    },
  });
  assert.ok(
    r.platform_claimed_roas > r.true_incremental_roas,
    `platform ${r.platform_claimed_roas} should exceed true ${r.true_incremental_roas}`
  );
});
