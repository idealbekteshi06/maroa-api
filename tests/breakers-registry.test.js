'use strict';

const test = require('node:test');
const assert = require('node:assert');

const breakers = require('../lib/breakers');

test('breakers: getBreaker returns a CircuitBreaker instance with configured thresholds', () => {
  breakers._resetAll();
  const meta = breakers.getBreaker('meta-marketing');
  assert.strictEqual(meta.name, 'meta-marketing');
  assert.strictEqual(meta.threshold, 5);
  assert.strictEqual(meta.openDurationMs, 30_000);
  assert.strictEqual(meta.state, 'closed');
});

test('breakers: paddle gets tight config — must recover fast for real payments', () => {
  breakers._resetAll();
  const paddle = breakers.getBreaker('paddle');
  assert.strictEqual(paddle.threshold, 3);
  assert.strictEqual(paddle.openDurationMs, 15_000);
});

test('breakers: higgsfield gets looser config — image gen is normally slow', () => {
  breakers._resetAll();
  const hf = breakers.getBreaker('higgsfield');
  assert.strictEqual(hf.threshold, 8);
  assert.strictEqual(hf.windowMs, 120_000);
});

test('breakers: unknown name gets default config + creates a real breaker', () => {
  breakers._resetAll();
  const unknown = breakers.getBreaker('some-new-api');
  assert.strictEqual(unknown.name, 'some-new-api');
  assert.strictEqual(unknown.threshold, 5);
  assert.strictEqual(unknown.state, 'closed');
});

test('breakers: fire() executes wrapped function and returns result on success', async () => {
  breakers._resetAll();
  const result = await breakers.fire('meta-marketing', async () => ({ ok: true, value: 42 }));
  assert.deepStrictEqual(result, { ok: true, value: 42 });
});

test('breakers: fire() propagates wrapped function errors', async () => {
  breakers._resetAll();
  await assert.rejects(
    () =>
      breakers.fire('meta-marketing', async () => {
        throw new Error('downstream_failed');
      }),
    /downstream_failed/
  );
});

test('breakers: fire() trips circuit after threshold failures, then fast-fails', async () => {
  breakers._resetAll();
  const paddle = breakers.getBreaker('paddle');
  // Paddle threshold is 3 — fail 3 times to trip
  for (let i = 0; i < 3; i++) {
    try {
      await breakers.fire('paddle', async () => {
        throw new Error('paddle_down');
      });
    } catch {
      /* expected */
    }
  }
  assert.strictEqual(paddle.state, 'open', 'should be OPEN after threshold failures');

  // 4th call should fast-fail with CircuitOpenError
  let caught;
  try {
    await breakers.fire('paddle', async () => ({ ok: true }));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'should throw immediately when open');
  assert.strictEqual(caught.isCircuitOpen, true);
  assert.strictEqual(caught.breakerName, 'paddle');
});

test('breakers: snapshot() reports state of all instantiated breakers', () => {
  breakers._resetAll();
  breakers.getBreaker('paddle');
  breakers.getBreaker('higgsfield');
  const snap = breakers.snapshot();
  assert.ok(snap.paddle, 'should include paddle');
  assert.ok(snap.higgsfield, 'should include higgsfield');
  assert.strictEqual(snap.paddle.state, 'closed');
  assert.strictEqual(snap.higgsfield.state, 'closed');
});

test('breakers: configureBreakers wires alert router (state-change emits a valid alert)', async () => {
  breakers._resetAll();
  const alerts = [];
  // The router exposes alert() with severities info|warning|error|critical.
  // Previously breakers called a non-existent publish() with severity 'warn',
  // so circuit-open alerts silently never fired.
  const fakeRouter = {
    alert: (a) => {
      alerts.push(a);
      return Promise.resolve();
    },
  };
  breakers.configureBreakers({ alertRouter: fakeRouter, logger: null });

  // Force a trip
  for (let i = 0; i < 3; i++) {
    try {
      await breakers.fire('paddle', async () => {
        throw new Error('forced');
      });
    } catch {
      /* expected */
    }
  }
  const openAlert = alerts.find((a) => a.key === 'circuit-open:paddle');
  assert.ok(openAlert, 'alertRouter.alert should fire on circuit OPEN');
  assert.strictEqual(openAlert.severity, 'warning', 'severity must be a valid enum value');
  // Clean up so it doesn't leak into other tests
  breakers.configureBreakers({ alertRouter: null, logger: null });
});

test('breakers: configureBreakers null inputs do not error', () => {
  breakers._resetAll();
  assert.doesNotThrow(() => breakers.configureBreakers({}));
  assert.doesNotThrow(() => breakers.configureBreakers());
});

test('breakers: BREAKER_CONFIG is frozen + immutable (cannot be tampered at runtime)', () => {
  assert.throws(() => {
    breakers.BREAKER_CONFIG.paddle = { threshold: 999 };
  }, /(read-only|TypeError|Cannot assign)/);
});
