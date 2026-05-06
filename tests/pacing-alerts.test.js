'use strict';

/**
 * tests/pacing-alerts.test.js
 * Test suite for pacing alerts rule engine.
 */

const test = require('node:test');
const assert = require('node:assert');

const pacing = require('../services/prompts/pacing-alerts');

// ─── 1-6. Each rule fires on intended condition ────────────────────────────

test('P01: spend pacing fires when spend > 130% of expected', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { spend: 50, daily_budget: 60 },
    hours_elapsed: 6, // expected ≈ $15; 50 is way over
  });
  assert.ok(alerts.find(a => a.rule_id === 'P01'));
});

test('P01: does NOT fire when spend on pace', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { spend: 15, daily_budget: 60 },
    hours_elapsed: 6, // expected $15, spend $15 → on pace
  });
  assert.strictEqual(alerts.find(a => a.rule_id === 'P01'), undefined);
});

test('P02: ROAS collapse fires on <0.5 ROAS with >30 clicks in 6h', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { spend: 50, daily_budget: 100 },
    recent_window: { roas: 0.3, clicks: 50 },
  });
  const p02 = alerts.find(a => a.rule_id === 'P02');
  assert.ok(p02);
  assert.strictEqual(p02.severity, 'critical');
});

test('P02: does NOT fire when sample too small (<30 clicks)', () => {
  const alerts = pacing.evaluatePacing({
    recent_window: { roas: 0.2, clicks: 10 },
  });
  assert.strictEqual(alerts.find(a => a.rule_id === 'P02'), undefined);
});

test('P03: CPA blowout fires when cpa > 3x target with >10 conversions', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { cpa: 90, target_cpa: 25, conversions: 15 },
  });
  assert.ok(alerts.find(a => a.rule_id === 'P03'));
});

test('P04: frequency spike fires when freq rose >25% in 24h', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { frequency: 3.5 },
    prev_24h: { frequency: 2.5 },
  });
  assert.ok(alerts.find(a => a.rule_id === 'P04'));
});

test('P05: zero-clicks fires for active campaign idle >12h', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { status: 'ACTIVE', clicks: 0 },
    hours_since_first_click: 16,
  });
  assert.ok(alerts.find(a => a.rule_id === 'P05'));
});

test('P06: ad rejection fires immediately', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { ad_status: 'REJECTED' },
  });
  const p06 = alerts.find(a => a.rule_id === 'P06');
  assert.ok(p06);
  assert.strictEqual(p06.severity, 'critical');
});

// ─── 8-9. Multiple alerts + zero alerts ────────────────────────────────────

test('multiple rules fire simultaneously', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { spend: 50, daily_budget: 60, ad_status: 'REJECTED', frequency: 3.5 },
    recent_window: { roas: 0.3, clicks: 50 },
    prev_24h: { frequency: 2.5 },
    hours_elapsed: 6,
  });
  assert.ok(alerts.length >= 3);
});

test('no alerts fire on healthy campaign', () => {
  const alerts = pacing.evaluatePacing({
    metrics: { spend: 15, daily_budget: 60, frequency: 1.5, status: 'ACTIVE', clicks: 100 },
    recent_window: { roas: 2.5, clicks: 50 },
    prev_24h: { frequency: 1.4 },
    hours_elapsed: 6,
    hours_since_first_click: 2,
  });
  assert.strictEqual(alerts.length, 0);
});
