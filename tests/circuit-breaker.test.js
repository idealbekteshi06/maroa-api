'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { CircuitBreaker, CircuitOpenError, getBreaker, allBreakers } = require('../lib/circuitBreaker');

// ─── State machine: CLOSED → OPEN → HALF_OPEN → CLOSED ──────────────────

test('breaker: starts in CLOSED state', () => {
  const b = new CircuitBreaker({ name: 'test' });
  assert.strictEqual(b.state, 'closed');
  assert.strictEqual(b.failureCount, 0);
});

test('breaker: trips to OPEN after threshold failures', async () => {
  const b = new CircuitBreaker({ name: 't1', threshold: 3, windowMs: 10000 });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () =>
        b.fire(async () => {
          throw new Error('boom');
        }),
      /boom/
    );
  }
  assert.strictEqual(b.state, 'open');
  assert.strictEqual(b.failureCount, 3);
});

test('breaker: OPEN state fast-fails with CircuitOpenError', async () => {
  const b = new CircuitBreaker({ name: 't2', threshold: 1, openDurationMs: 10000 });
  await assert.rejects(
    () =>
      b.fire(async () => {
        throw new Error('first');
      }),
    /first/
  );
  assert.strictEqual(b.state, 'open');

  let called = false;
  await assert.rejects(
    () =>
      b.fire(async () => {
        called = true;
        return 'should not run';
      }),
    (err) => err instanceof CircuitOpenError
  );
  assert.strictEqual(called, false, 'OPEN breaker must NOT invoke fn');
});

test('breaker: transitions to HALF_OPEN after cooldown', async () => {
  const b = new CircuitBreaker({ name: 't3', threshold: 1, openDurationMs: 10 });
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('x');
    })
  );
  assert.strictEqual(b.state, 'open');
  await new Promise((r) => setTimeout(r, 20));
  // Next fire triggers half-open evaluation
  await b.fire(async () => 'ok');
  assert.strictEqual(b.state, 'closed');
});

test('breaker: HALF_OPEN failure re-trips to OPEN', async () => {
  const b = new CircuitBreaker({ name: 't4', threshold: 1, openDurationMs: 10 });
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('e1');
    })
  );
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('e2');
    })
  );
  assert.strictEqual(b.state, 'open');
});

test('breaker: success resets in CLOSED state (failures decay by time window)', async () => {
  const b = new CircuitBreaker({ name: 't5', threshold: 5, windowMs: 50 });
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('a');
    })
  );
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('b');
    })
  );
  assert.strictEqual(b.failureCount, 2);
  await new Promise((r) => setTimeout(r, 70)); // window expires
  assert.strictEqual(b.failureCount, 0);
  assert.strictEqual(b.state, 'closed');
});

test('breaker: snapshot exposes diagnostic fields', () => {
  const b = new CircuitBreaker({ name: 'snap-test', threshold: 5, openDurationMs: 30000 });
  const snap = b.snapshot();
  assert.strictEqual(snap.name, 'snap-test');
  assert.strictEqual(snap.state, 'closed');
  assert.strictEqual(snap.threshold, 5);
  assert.strictEqual(snap.failure_count, 0);
  assert.strictEqual(snap.open_duration_ms, 30000);
});

test('breaker: onStateChange callback fires on transitions', async () => {
  const transitions = [];
  const b = new CircuitBreaker({
    name: 'cb-test',
    threshold: 1,
    openDurationMs: 10,
    onStateChange: ({ state }) => transitions.push(state),
  });
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('x');
    })
  );
  await new Promise((r) => setTimeout(r, 20));
  await b.fire(async () => 'ok');
  assert.deepStrictEqual(transitions, ['open', 'half_open', 'closed']);
});

// ─── Registry ─────────────────────────────────────────────────────────────

test('registry: getBreaker returns the same instance for the same name', () => {
  const a = getBreaker('meta-api-test');
  const b = getBreaker('meta-api-test');
  assert.strictEqual(a, b);
});

test('registry: getBreaker creates distinct instances for different names', () => {
  const a = getBreaker('alpha-test');
  const b = getBreaker('beta-test');
  assert.notStrictEqual(a, b);
});

test('registry: allBreakers returns snapshots of every registered breaker', () => {
  getBreaker('reg-1');
  getBreaker('reg-2');
  const all = allBreakers();
  const names = all.map((s) => s.name);
  assert.ok(names.includes('reg-1'));
  assert.ok(names.includes('reg-2'));
});

// ─── CircuitOpenError details ─────────────────────────────────────────────

test('CircuitOpenError: carries breaker name + cooldown', async () => {
  const b = new CircuitBreaker({ name: 'err-detail', threshold: 1, openDurationMs: 5000 });
  await assert.rejects(() =>
    b.fire(async () => {
      throw new Error('x');
    })
  );
  try {
    await b.fire(async () => 'never');
    assert.fail('Expected CircuitOpenError');
  } catch (err) {
    assert.strictEqual(err.isCircuitOpen, true);
    assert.strictEqual(err.breakerName, 'err-detail');
    assert.ok(err.cooldownMs >= 0);
    assert.ok(err.cooldownMs <= 5000);
  }
});
