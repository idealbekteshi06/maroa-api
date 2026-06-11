'use strict';

// lib/rateLimit contract tests — written for the 2026-06-11 production
// incident: Upstash credentials went stale after the audit's secret
// rotation, rl.limit() rejected after ~6s of SDK retries, and every call
// site that awaited checkRateLimit() bare inside an async Express 4 handler
// hung forever (no response ever sent → "Connection error" toast in the
// dashboard). The contract under test: checkRateLimit NEVER rejects and
// NEVER stalls past LIMIT_DECISION_TIMEOUT_MS — it fails OPEN with
// {success:true, degraded:true} so handlers always answer, and callers that
// must not uncap expensive endpoints (aiRateLimit) read `degraded` to fall
// back to the in-process limiter.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRateLimit, LIMIT_DECISION_TIMEOUT_MS } = require('../lib/rateLimit');

test('rateLimit: no limiter configured → plain fail-open, not degraded', async () => {
  // No UPSTASH_* env in tests and no injected limiter.
  const out = await checkRateLimit('user-1');
  assert.equal(out.success, true);
  assert.equal(out.degraded, undefined);
});

test('rateLimit: healthy limiter decision passes through untouched', async () => {
  const fake = { limit: async (id) => ({ success: false, limit: 20, remaining: 0, reset: 123, id }) };
  const out = await checkRateLimit('user-2', fake);
  assert.equal(out.success, false);
  assert.equal(out.remaining, 0);
  assert.equal(out.degraded, undefined);
});

test('rateLimit: rejecting limiter (rotated/invalid creds) fails open with degraded flag', async () => {
  const fake = {
    limit: async () => {
      throw new Error('Unauthorized: invalid token');
    },
  };
  const out = await checkRateLimit('user-3', fake);
  assert.equal(out.success, true);
  assert.equal(out.degraded, true);
  assert.match(out.reason, /invalid token/);
});

test('rateLimit: stalling limiter is cut off by the decision timeout', async () => {
  const fake = { limit: () => new Promise(() => {}) }; // never settles
  const started = Date.now();
  const out = await checkRateLimit('user-4', fake);
  const elapsed = Date.now() - started;
  assert.equal(out.success, true);
  assert.equal(out.degraded, true);
  assert.equal(out.reason, 'timeout');
  // Bounded: well under double the configured ceiling, never an infinite hang.
  assert.ok(
    elapsed < LIMIT_DECISION_TIMEOUT_MS * 2,
    `decision took ${elapsed}ms, ceiling ${LIMIT_DECISION_TIMEOUT_MS}ms`
  );
});

test('rateLimit: never rejects even with a pathological limiter', async () => {
  const fake = {
    limit: () => {
      // Throw synchronously (not a rejected promise) — worst case.
      throw new TypeError('boom');
    },
  };
  // Must resolve, not reject.
  const out = await checkRateLimit('user-5', fake);
  assert.equal(out.success, true);
  assert.equal(out.degraded, true);
});
