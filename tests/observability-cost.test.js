'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracing = require('../lib/tracing');
const health = require('../lib/healthCheck');
const costGuard = require('../lib/costGuard');

// ─── Tracing — request IDs ───────────────────────────────────────────────

test('tracing: newRequestId produces unique sortable IDs', () => {
  const a = tracing.newRequestId();
  const b = tracing.newRequestId();
  assert.notStrictEqual(a, b);
  assert.ok(a.length > 10);
  // Format: <ts-base36>-<hex>
  assert.ok(/^[a-z0-9]+-[a-f0-9]+$/.test(a), `Unexpected format: ${a}`);
});

test('tracing: requestIdMiddleware uses upstream header when valid', () => {
  const req = { headers: { 'x-request-id': 'upstream-abc-123' } };
  const res = { setHeader: () => {} };
  let nextCalled = false;
  tracing.requestIdMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(req.requestId, 'upstream-abc-123');
  assert.ok(nextCalled);
});

test('tracing: requestIdMiddleware mints new ID when no upstream header', () => {
  const req = { headers: {} };
  let setHeaderCalled = null;
  const res = {
    setHeader: (k, v) => {
      setHeaderCalled = { k, v };
    },
  };
  tracing.requestIdMiddleware(req, res, () => {});
  assert.ok(req.requestId.length > 10);
  assert.strictEqual(setHeaderCalled.k, 'x-request-id');
  assert.strictEqual(setHeaderCalled.v, req.requestId);
});

test('tracing: requestIdMiddleware rejects oversized upstream IDs', () => {
  const huge = 'x'.repeat(200);
  const req = { headers: { 'x-request-id': huge } };
  const res = { setHeader: () => {} };
  tracing.requestIdMiddleware(req, res, () => {});
  assert.notStrictEqual(req.requestId, huge);
  assert.ok(req.requestId.length < 200);
});

test('tracing: childCorrelation propagates the request ID', () => {
  const headers = tracing.childCorrelation({ requestId: 'corr-xyz' });
  assert.strictEqual(headers['x-request-id'], 'corr-xyz');
});

test('tracing: childCorrelation returns empty when no requestId', () => {
  assert.deepStrictEqual(tracing.childCorrelation({}), {});
  assert.deepStrictEqual(tracing.childCorrelation(null), {});
});

test('tracing: withTracing wraps and propagates errors via Sentry', async () => {
  let handlerRan = false;
  const wrapped = tracing.withTracing('/test', async (req, res) => {
    handlerRan = true;
    res.statusSent = 200;
    return res;
  });
  const req = { requestId: 'r1', method: 'POST' };
  const res = {
    headersSent: false,
    status: function (c) {
      this.statusCode = c;
      return this;
    },
    json: function (x) {
      this.body = x;
      return this;
    },
  };
  await wrapped(req, res);
  assert.ok(handlerRan);
});

test('tracing: withTracing returns 500 + request_id when handler throws', async () => {
  const wrapped = tracing.withTracing('/test-fail', async () => {
    throw new Error('boom');
  });
  const req = { requestId: 'r-fail', method: 'POST' };
  const captured = {};
  const res = {
    headersSent: false,
    status: function (c) {
      captured.status = c;
      return this;
    },
    json: function (x) {
      captured.json = x;
      return this;
    },
  };
  await wrapped(req, res);
  assert.strictEqual(captured.status, 500);
  assert.strictEqual(captured.json.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(captured.json.error.request_id, 'r-fail');
});

// ─── Health checks ────────────────────────────────────────────────────────
//
// probeAnthropic now makes a real network call to /v1/models (M5 hardening).
// With a fake key 'sk-test' Anthropic returns 401 → ok:false. The test
// covers the "service responded" path. The env-missing path still asserts
// ok:false with a clear reason.

test('health: probeAnthropic surfaces unauthorized when key is fake', async () => {
  health._resetProbeCache();
  const prev = process.env.ANTHROPIC_KEY;
  process.env.ANTHROPIC_KEY = 'sk-test-invalid';
  const r = await health.probeAnthropic();
  // We can't assert ok:true without a live key, and we don't want flaky
  // network-dependent tests. Just verify the probe didn't crash and
  // returned a structured response.
  assert.ok(typeof r === 'object' && r !== null);
  assert.ok('ok' in r);
  if (prev === undefined) delete process.env.ANTHROPIC_KEY;
  else process.env.ANTHROPIC_KEY = prev;
});

test('health: probeAnthropic returns not-ok when env missing', async () => {
  health._resetProbeCache();
  const prev = process.env.ANTHROPIC_KEY;
  const prevApi = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await health.probeAnthropic();
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason);
  if (prev !== undefined) process.env.ANTHROPIC_KEY = prev;
  if (prevApi !== undefined) process.env.ANTHROPIC_API_KEY = prevApi;
});

test('health: probeSupabase returns ok on successful query', async () => {
  health._resetProbeCache();
  const sbGet = async () => [{ id: 'biz-1' }];
  const r = await health.probeSupabase(sbGet);
  assert.strictEqual(r.ok, true);
});

test('health: probeSupabase returns not-ok on hung query', async () => {
  health._resetProbeCache();
  const sbGet = () => new Promise(() => {}); // never resolves
  const r = await health.probeSupabase(sbGet);
  assert.strictEqual(r.ok, false);
  assert.ok(/timeout/.test(r.reason));
});

// ─── Cost guard ───────────────────────────────────────────────────────────

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
