'use strict';

/**
 * tests/slos.test.js
 *
 * Verifies services/observability/slos.js — the SLO catalog and breach
 * detection.
 */

const test = require('node:test');
const assert = require('node:assert');

const metrics = require('../services/observability/metrics');
const slos = require('../services/observability/slos');

test('slos: catalog has all expected SLOs declared', () => {
  const ids = slos.SLOS.map((s) => s.id);
  assert.ok(ids.includes('api_availability'));
  assert.ok(ids.includes('api_latency_p99'));
  assert.ok(ids.includes('webhook_delivery'));
  assert.ok(ids.includes('inngest_function_success'));
  assert.ok(ids.includes('budget_enforcement'));
  assert.ok(ids.includes('oauth_token_decrypt_success'));
  assert.ok(ids.includes('cost_per_business_growth'));
});

test('slos: every SLO has required fields', () => {
  for (const slo of slos.SLOS) {
    assert.ok(slo.id, `${JSON.stringify(slo)} missing id`);
    assert.ok(slo.description, `${slo.id} missing description`);
    assert.ok(typeof slo.target === 'number', `${slo.id} target must be number`);
    assert.ok(slo.target > 0 && slo.target <= 1, `${slo.id} target must be 0<t<=1`);
    assert.ok(slo.metric, `${slo.id} missing metric`);
    assert.ok(typeof slo.threshold === 'number', `${slo.id} threshold must be number`);
    assert.strictEqual(slo.window_days, 30, `${slo.id} window must be 30d`);
  }
});

test('slos: getViolations returns empty when no metrics emitted', () => {
  metrics.reset();
  const violations = slos.getViolations();
  assert.strictEqual(violations.length, 0);
});

test('slos: budget_enforcement is a hard SLO — any overrun breaches', () => {
  metrics.reset();
  metrics.increment('budget_overrun_count', {}, 1);
  const violations = slos.getViolations();
  const overrun = violations.find((v) => v.slo_id === 'budget_enforcement');
  assert.ok(overrun, 'budget overrun should breach');
  assert.strictEqual(overrun.current, 1);
});

test('slos: api_latency_p99 breaches when histogram p99 exceeds 800ms', () => {
  metrics.reset();
  // Push 100 fast observations and 5 slow ones — p99 should be in the slow bucket
  for (let i = 0; i < 100; i++) metrics.observeHistogram('http_request_p99_ms', 50);
  for (let i = 0; i < 5; i++) metrics.observeHistogram('http_request_p99_ms', 2500);
  const violations = slos.getViolations();
  const latency = violations.find((v) => v.slo_id === 'api_latency_p99');
  assert.ok(latency, 'p99 should breach 800ms threshold');
});

test('slos: api_latency_p99 does not breach when all under threshold', () => {
  metrics.reset();
  for (let i = 0; i < 1000; i++) metrics.observeHistogram('http_request_p99_ms', 100);
  const violations = slos.getViolations();
  assert.strictEqual(
    violations.find((v) => v.slo_id === 'api_latency_p99'),
    undefined
  );
});

test('slos: startSloMonitor is no-op in NODE_ENV=test', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const handle = slos.startSloMonitor({ intervalMs: 1000 });
  process.env.NODE_ENV = prev;
  assert.strictEqual(handle, null);
});
