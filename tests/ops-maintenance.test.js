'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  detectCrisisSignals,
  normalizePlan,
  isPaidActive,
  isGrowthPlus,
} = require('../services/ops-maintenance');

test('ops-maintenance: normalizePlan maps free to starter', () => {
  assert.strictEqual(normalizePlan('free'), 'starter');
  assert.strictEqual(normalizePlan('GROWTH'), 'growth');
});

test('ops-maintenance: plan gates', () => {
  assert.strictEqual(isPaidActive({ id: '1', is_active: true, plan: 'starter' }), true);
  assert.strictEqual(isPaidActive({ id: '1', is_active: true, plan: 'free' }), true);
  assert.strictEqual(isPaidActive({ id: '1', is_active: false, plan: 'growth' }), false);
  assert.strictEqual(isGrowthPlus({ id: '1', is_active: true, plan: 'growth' }), true);
  assert.strictEqual(isGrowthPlus({ id: '1', is_active: true, plan: 'starter' }), false);
});

test('ops-maintenance: detectCrisisSignals — healthy baseline', () => {
  const r = detectCrisisSignals({
    thisWeekSnaps: [{ reach: 100 }],
    lastWeekSnaps: [{ reach: 90 }],
    campaigns: [{ total_spend: 5, conversions: 1 }],
    errors: [],
    reviews: [{ rating: 5 }],
  });
  assert.strictEqual(r.signals.length, 0);
});

test('ops-maintenance: detectCrisisSignals — reach collapse', () => {
  const r = detectCrisisSignals({
    thisWeekSnaps: [{ reach: 10 }],
    lastWeekSnaps: [{ reach: 100 }],
    campaigns: [],
    errors: [],
    reviews: [],
  });
  assert.ok(r.signals.some((s) => s.type === 'audience_collapse' || s.type === 'reach_collapse'));
});

test('ops-maintenance: detectCrisisSignals — wasted spend', () => {
  const r = detectCrisisSignals({
    thisWeekSnaps: [{ reach: 50 }],
    lastWeekSnaps: [{ reach: 50 }],
    campaigns: [{ total_spend: 50, conversions: 0 }],
    errors: [],
    reviews: [],
  });
  assert.ok(r.signals.some((s) => s.type === 'wasted_spend'));
});
