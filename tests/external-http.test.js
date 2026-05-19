'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const externalHttp = require('../lib/externalHttp');
const breakers = require('../lib/breakers');

function fakeApiRequest(plan) {
  let i = 0;
  return async (_method, _url, _headers, _body, _timeout) => {
    const next = plan[Math.min(i, plan.length - 1)];
    i += 1;
    if (typeof next === 'function') return next();
    return next;
  };
}

test.beforeEach(() => breakers._resetAll());

test('returns 200 on first success', async () => {
  const r = await externalHttp(
    fakeApiRequest([{ status: 200, body: { ok: true } }]),
    'GET',
    'https://api.anthropic.com/v1/test'
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('retries on 503 then succeeds', async () => {
  const r = await externalHttp(
    fakeApiRequest([
      { status: 503, body: { error: 'down' } },
      { status: 503, body: { error: 'down' } },
      { status: 200, body: { ok: true } },
    ]),
    'GET',
    'https://api.anthropic.com/v1/test',
    {},
    null,
    { baseDelayMs: 1, maxDelayMs: 5 }
  );
  assert.equal(r.status, 200);
});

test('does not retry on 401', async () => {
  let calls = 0;
  const apiRequest = async () => {
    calls += 1;
    return { status: 401, body: { error: 'unauthorized' } };
  };
  const r = await externalHttp(apiRequest, 'GET', 'https://api.anthropic.com/v1/test');
  assert.equal(r.status, 401);
  assert.equal(calls, 1);
});

test('trips breaker after persistent 503', async () => {
  // 1 breaker call = 1 retryWithJitter sequence (up to 3 attempts).
  // Each call inside the breaker sees 3 failures → 1 breaker failure.
  // Anthropic threshold is 5 failures in 60s.
  // So we need 5 calls to externalHttp before breaker opens.
  const persistent503 = async () => ({ status: 503, body: { error: 'down' } });
  for (let i = 0; i < 5; i++) {
    try {
      await externalHttp(persistent503, 'GET', 'https://api.anthropic.com/v1/test', {}, null, {
        retries: 0,
        baseDelayMs: 1,
      });
    } catch {
      /* expected */
    }
  }
  // 6th should fast-fail with CircuitOpenError
  await assert.rejects(
    externalHttp(persistent503, 'GET', 'https://api.anthropic.com/v1/test', {}, null, {
      retries: 0,
      baseDelayMs: 1,
    }),
    (e) => e.isCircuitOpen === true
  );
});

test('passes through unmapped hosts without breaker', async () => {
  const apiRequest = async () => ({ status: 200, body: { ok: true } });
  const r = await externalHttp(apiRequest, 'GET', 'https://random.example.com/');
  assert.equal(r.status, 200);
  assert.equal(r.fromBreakerName, null);
});

test('picks anthropic breaker by hostname', async () => {
  const apiRequest = async () => ({ status: 200, body: { ok: true } });
  const r = await externalHttp(apiRequest, 'GET', 'https://api.anthropic.com/v1/test');
  assert.equal(r.fromBreakerName, 'anthropic');
});
