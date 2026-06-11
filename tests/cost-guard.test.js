'use strict';

// Cost-guard unit tests. Extracted from observability-cost.test.js
// (2026-06-11) so the Stryker command runner can exercise lib/costGuard
// without paying for the slow health-probe tests (a deliberate 2.5s
// hung-query timeout) on every mutant. Keep this file fast and
// network-free — it runs once per mutant in mutation testing.

const test = require('node:test');
const assert = require('node:assert');

const costGuard = require('../lib/costGuard');

// List pricing: starter $25 → cap $30, growth $59 → $80, agency $99 → $250.
test('costGuard: effectiveCapForPlan honors plan tiers', () => {
  assert.strictEqual(costGuard.effectiveCapForPlan('starter'), 30);
  assert.strictEqual(costGuard.effectiveCapForPlan('growth'), 80);
  assert.strictEqual(costGuard.effectiveCapForPlan('agency'), 250);
  // Unknown / legacy plans → cheapest cap (fail-safe; was growth $80, which
  // let a typo'd/capitalized plan silently receive the higher cap).
  assert.strictEqual(costGuard.effectiveCapForPlan('unknown'), 30);
  assert.strictEqual(costGuard.effectiveCapForPlan('free'), 30);
});

test('costGuard: env override hatch wins', () => {
  process.env.COST_CAP_GROWTH_USD = '999';
  assert.strictEqual(costGuard.effectiveCapForPlan('growth'), 999);
  delete process.env.COST_CAP_GROWTH_USD;
});

test('costGuard: checkCostCap allows when under cap', async () => {
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ plan: 'growth' }];
    if (table === 'llm_cost_logs') return [{ cost_usd: 5 }, { cost_usd: 10 }];
    return [];
  };
  const r = await costGuard.checkCostCap({ businessId: '11111111-1111-4111-8111-111111111111', sbGet });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.plan, 'growth');
  assert.strictEqual(r.cap_usd, 80);
  assert.strictEqual(r.used_usd, 15);
  assert.strictEqual(r.remaining_usd, 65);
});

test('costGuard: checkCostCap denies when at or over cap', async () => {
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ plan: 'growth' }];
    // 60 + 25 = 85, over the $80 growth cap
    if (table === 'llm_cost_logs') return [{ cost_usd: 60 }, { cost_usd: 25 }];
    return [];
  };
  const r = await costGuard.checkCostCap({ businessId: '22222222-2222-4222-8222-222222222222', sbGet });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'monthly_cap_reached');
});

test('costGuard: soft-fails on missing telemetry table (allows call)', async () => {
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ plan: 'growth' }];
    if (table === 'llm_cost_logs') throw new Error('relation does not exist');
    return [];
  };
  const r = await costGuard.checkCostCap({ businessId: '33333333-3333-4333-8333-333333333333', sbGet });
  assert.strictEqual(r.allowed, true);
  assert.ok(r.soft_fail || /soft-allow|cost_guard_error/.test(r.reason || ''));
});

test('costGuardMiddleware: returns 402 when cap reached', async () => {
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ plan: 'growth' }];
    if (table === 'llm_cost_logs') return [{ cost_usd: 100 }]; // over $80 growth cap
    return [];
  };
  const mw = costGuard.costGuardMiddleware({ sbGet });
  let captured = {};
  const req = { body: { businessId: '44444444-4444-4444-8444-444444444444' } };
  const res = {
    status: function (c) {
      captured.status = c;
      return this;
    },
    json: function (x) {
      captured.json = x;
      return this;
    },
  };
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(captured.status, 402);
  assert.strictEqual(captured.json.error.code, 'COST_CAP_REACHED');
  assert.strictEqual(nextCalled, false);
});

test('costGuardMiddleware: passes through when no businessId', async () => {
  const mw = costGuard.costGuardMiddleware({ sbGet: async () => [] });
  const req = { body: {} };
  let nextCalled = false;
  await mw(req, {}, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
});
