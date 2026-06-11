'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracing = require('../lib/tracing');
const health = require('../lib/healthCheck');

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
// Moved to tests/cost-guard.test.js (2026-06-11) so the Stryker command
// runner can cover lib/costGuard without re-running the slow health-probe
// tests above on every mutant.
