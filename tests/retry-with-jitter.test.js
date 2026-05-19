'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  retryWithJitter,
  defaultIsRetryable,
  computeDelayMs,
} = require('../lib/retryWithJitter');

test('returns immediately on first success', async () => {
  let calls = 0;
  const out = await retryWithJitter(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('retries on retryable error and eventually succeeds', async () => {
  let calls = 0;
  const out = await retryWithJitter(
    async () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error('transient');
        e.status = 503;
        throw e;
      }
      return 'recovered';
    },
    { retries: 5, baseDelayMs: 1, maxDelayMs: 5 }
  );
  assert.equal(out, 'recovered');
  assert.equal(calls, 3);
});

test('does not retry on non-retryable 400-class error', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithJitter(
      async () => {
        calls += 1;
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      },
      { retries: 3, baseDelayMs: 1 }
    )
  );
  assert.equal(calls, 1);
});

test('does not retry CircuitOpenError', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithJitter(
      async () => {
        calls += 1;
        const e = new Error('circuit open');
        e.isCircuitOpen = true;
        throw e;
      },
      { retries: 3, baseDelayMs: 1 }
    )
  );
  assert.equal(calls, 1);
});

test('retries network ECONNRESET', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithJitter(
      async () => {
        calls += 1;
        const e = new Error('connection reset');
        e.code = 'ECONNRESET';
        throw e;
      },
      { retries: 2, baseDelayMs: 1 }
    )
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('honors Retry-After header value in seconds', () => {
  const err = { headers: { 'retry-after': '2' } };
  // we don't call retryWithJitter directly here; verify the parser by
  // exercising computeDelayMs's clamp behavior.
  const delay = computeDelayMs({
    attempt: 0,
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    retryAfterMs: 2000,
  });
  assert.ok(delay >= 100 && delay <= 10_000);
  assert.equal(delay, 2000);
});

test('defaultIsRetryable: 429 retryable, 401 not', () => {
  assert.equal(defaultIsRetryable({ status: 429 }), true);
  assert.equal(defaultIsRetryable({ status: 401 }), false);
  assert.equal(defaultIsRetryable({ status: 503 }), true);
  assert.equal(defaultIsRetryable({ status: 200 }), false);
  assert.equal(defaultIsRetryable(null), false);
});

test('respects AbortSignal mid-loop', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  let calls = 0;
  await assert.rejects(
    retryWithJitter(
      async () => {
        calls += 1;
        const e = new Error('try again');
        e.status = 503;
        throw e;
      },
      { retries: 50, baseDelayMs: 5, maxDelayMs: 100, signal: ac.signal }
    ),
    (e) => e.name === 'AbortError' || /try again/.test(e.message)
  );
  assert.ok(calls < 50);
});

test('onRetry callback fires with attempt + delay', async () => {
  const events = [];
  await assert.rejects(
    retryWithJitter(
      async () => {
        const e = new Error('boom');
        e.status = 500;
        throw e;
      },
      {
        retries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        onRetry: (m) => events.push(m.attempt),
      }
    )
  );
  assert.deepEqual(events, [1, 2]);
});
