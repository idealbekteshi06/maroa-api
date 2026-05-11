'use strict';

/**
 * tests/abuse-detector.test.js
 *
 * Verifies lib/abuseDetector.js — the sliding-window anomaly tripwire
 * that catches credential probing, validation floods, route scanners,
 * business-id enumeration, and webhook-signature scanners.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createDetector, PATTERNS } = require('../lib/abuseDetector');

function makeReq({ ip = '1.2.3.4', path = '/api/foo', body = {} } = {}) {
  return { ip, path, body, query: {}, params: {} };
}
function makeRes({ statusCode = 200 } = {}) {
  const calls = { json: [] };
  const res = {
    statusCode,
    json(body) {
      calls.json.push(body);
      return this;
    },
    _calls: calls,
  };
  return res;
}

function fireRequests({ detector, count, statusCode, ip = '1.2.3.4', path = '/api/foo' }) {
  for (let i = 0; i < count; i++) {
    const req = makeReq({ ip, path });
    const res = makeRes({ statusCode });
    detector.middleware(req, res, () => {});
    res.json({});
  }
}

test('PATTERNS defines the 5 expected detection rules', () => {
  for (const k of ['failed_auth', 'validation_fail', 'route_scanner', 'biz_enumeration', 'invalid_signature']) {
    assert.ok(PATTERNS[k], `missing pattern: ${k}`);
    assert.strictEqual(typeof PATTERNS[k].threshold, 'number');
    assert.ok(['low', 'medium', 'high', 'critical'].includes(PATTERNS[k].severity));
  }
});

test('detector: failed_auth fires after 10 × 401s in a minute', () => {
  const warns = [];
  const logger = { warn: (route, biz, msg, data) => warns.push({ msg, data }) };
  const detector = createDetector({ logger });

  fireRequests({ detector, count: 9, statusCode: 401 });
  assert.strictEqual(warns.length, 0, 'should not fire under threshold');

  fireRequests({ detector, count: 1, statusCode: 401 });
  assert.ok(warns.length >= 1, 'should fire at threshold');
  assert.ok(/failed_auth/.test(warns[0].msg));
  assert.strictEqual(warns[0].data.severity, 'high');
});

test('detector: validation_fail fires after 20 × 400s in a minute', () => {
  const warns = [];
  const logger = { warn: (route, biz, msg, data) => warns.push({ msg, data }) };
  const detector = createDetector({ logger });

  fireRequests({ detector, count: 19, statusCode: 400 });
  assert.strictEqual(warns.length, 0);

  fireRequests({ detector, count: 1, statusCode: 400 });
  assert.ok(warns.some((w) => /validation_fail/.test(w.msg)));
});

test('detector: route_scanner fires after 15 × 404s in a minute', () => {
  const warns = [];
  const logger = { warn: (route, biz, msg, data) => warns.push({ msg, data }) };
  const detector = createDetector({ logger });

  fireRequests({ detector, count: 14, statusCode: 404 });
  assert.strictEqual(warns.length, 0);

  fireRequests({ detector, count: 1, statusCode: 404 });
  assert.ok(warns.some((w) => /route_scanner/.test(w.msg)));
});

test('detector: alert cooldown — same pattern + IP not re-alerted within 5 min', () => {
  const warns = [];
  const logger = { warn: (route, biz, msg, data) => warns.push({ msg, data }) };
  const detector = createDetector({ logger });

  // Trip the threshold once
  fireRequests({ detector, count: 10, statusCode: 401 });
  const beforeFloodCount = warns.filter((w) => /failed_auth/.test(w.msg)).length;
  assert.ok(beforeFloodCount >= 1);

  // Flood more — should NOT re-alert within 5 min
  fireRequests({ detector, count: 100, statusCode: 401 });
  const afterFloodCount = warns.filter((w) => /failed_auth/.test(w.msg)).length;
  assert.strictEqual(afterFloodCount, beforeFloodCount, 'alert cooldown should suppress duplicate alerts');
});

test('detector: different IPs tracked independently', () => {
  const warns = [];
  const logger = { warn: (route, biz, msg, data) => warns.push({ msg, data }) };
  const detector = createDetector({ logger });

  fireRequests({ detector, count: 10, statusCode: 401, ip: '1.1.1.1' });
  fireRequests({ detector, count: 10, statusCode: 401, ip: '2.2.2.2' });
  // Should have 2 separate alerts, one per IP.
  const alerts = warns.filter((w) => /failed_auth/.test(w.msg));
  assert.strictEqual(alerts.length, 2);
  assert.ok(alerts.some((a) => a.data.ip === '1.1.1.1'));
  assert.ok(alerts.some((a) => a.data.ip === '2.2.2.2'));
});

test('detector: snapshot() returns per-IP counts', () => {
  const detector = createDetector({ logger: { warn: () => {} } });
  fireRequests({ detector, count: 3, statusCode: 401, ip: '5.5.5.5' });
  fireRequests({ detector, count: 2, statusCode: 404, ip: '5.5.5.5' });

  const snap = detector.snapshot();
  const entry = snap.find((s) => s.ip === '5.5.5.5');
  assert.ok(entry, 'IP should appear in snapshot');
  assert.strictEqual(entry.failed_auth, 3);
  assert.strictEqual(entry.route_scanner, 2);
});

test('detector: sentry capture fires when sentry provided', () => {
  const sentryCalls = [];
  const sentry = {
    captureMessage: (msg, opts) => sentryCalls.push({ msg, opts }),
  };
  const detector = createDetector({ logger: { warn: () => {} }, sentry });

  fireRequests({ detector, count: 10, statusCode: 401 });

  assert.ok(sentryCalls.length >= 1, 'sentry should receive the alert');
  assert.ok(/abuse: failed_auth/.test(sentryCalls[0].msg));
  assert.strictEqual(sentryCalls[0].opts.level, 'warning');
});

test('detector: never blocks the response — middleware always calls next', (t, done) => {
  const detector = createDetector({ logger: { warn: () => {} } });
  const req = makeReq();
  const res = makeRes();
  let nextCalled = false;
  detector.middleware(req, res, () => {
    nextCalled = true;
    done();
  });
  assert.strictEqual(nextCalled, true);
});

test('detector: biz_enumeration fires after 5 distinct business_ids from one IP', () => {
  const warns = [];
  const detector = createDetector({ logger: { warn: (r, b, m, d) => warns.push({ msg: m, data: d }) } });

  for (let i = 0; i < 5; i++) {
    const req = makeReq({ body: { business_id: `business-${i.toString().padStart(10, '0')}` } });
    const res = makeRes({ statusCode: 200 });
    detector.middleware(req, res, () => {});
    res.json({});
  }
  assert.ok(warns.some((w) => /biz_enumeration/.test(w.msg)));
});
