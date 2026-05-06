'use strict';

/**
 * tests/cro.test.js
 * ----------------------------------------------------------------------------
 * Test suite for CRO module — i18n + checks + scoring + schema + end-to-end.
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const cro = require('../services/prompts/cro');

// ─── 1-3. i18n CTA scoring ─────────────────────────────────────────────────

test('i18n-cro: scoreCta penalizes generic English CTAs', () => {
  const profile = cro.i18nCro.buildCroMarketProfile({ location: 'New York', primary_language: 'en' });
  const submit = cro.i18nCro.scoreCta('Submit', profile);
  const learn = cro.i18nCro.scoreCta('Learn more', profile);
  const action = cro.i18nCro.scoreCta('Get my quote', profile);
  assert.ok(action > submit + 3, `action CTA should crush "Submit": action=${action}, submit=${submit}`);
  assert.ok(action > learn, `action CTA should beat "Learn more": action=${action}, learn=${learn}`);
});

test('i18n-cro: scoreCta uses language-correct verbs (German + Albanian)', () => {
  const de = cro.i18nCro.buildCroMarketProfile({ location: 'Berlin', primary_language: 'de' });
  const sq = cro.i18nCro.buildCroMarketProfile({ location: 'Tirana', primary_language: 'sq' });
  const deCta = cro.i18nCro.scoreCta('Jetzt buchen', de);
  const sqCta = cro.i18nCro.scoreCta('Rezervo tani', sq);
  assert.ok(deCta >= 7, `German "Jetzt buchen" should score high, got ${deCta}`);
  assert.ok(sqCta >= 7, `Albanian "Rezervo tani" should score high, got ${sqCta}`);
});

test('i18n-cro: RTL flag set correctly for Arabic', () => {
  const ar = cro.i18nCro.buildCroMarketProfile({ location: 'Dubai', primary_language: 'ar' });
  assert.strictEqual(ar.text_direction, 'rtl');
  const en = cro.i18nCro.buildCroMarketProfile({ location: 'London', primary_language: 'en' });
  assert.strictEqual(en.text_direction, 'ltr');
});

// ─── 4-7. Page checks ──────────────────────────────────────────────────────

test('checks: C01 fires when no <h1> present', () => {
  const f = cro.checksPage.runChecks({
    html: '<html><body>Hello</body></html>',
    text: 'Hello',
    business: {},
    marketProfile: cro.i18nCro.buildCroMarketProfile({}),
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'C01'), 'C01 must fire on no-h1 page');
});

test('checks: C11 fires when no CTA button found', () => {
  const f = cro.checksPage.runChecks({
    html: '<html><body><h1>Welcome</h1><p>Hello</p></body></html>',
    text: 'Welcome', business: {},
    marketProfile: cro.i18nCro.buildCroMarketProfile({}),
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'C11'), 'C11 must fire on no-CTA page');
});

test('checks: C26 fires for too many form fields', () => {
  const html = `
    <form>
      ${'<input type="text" required>'.repeat(8)}
    </form>`;
  const f = cro.checksPage.runChecks({
    html, text: '', business: {}, marketProfile: cro.i18nCro.buildCroMarketProfile({}),
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'C26'), 'C26 must fire on 8-field form');
});

test('checks: C31 fires when no viewport meta tag', () => {
  const f = cro.checksPage.runChecks({
    html: '<html><head></head><body><h1>X</h1><button>Get</button></body></html>',
    text: 'x', business: {}, marketProfile: cro.i18nCro.buildCroMarketProfile({}),
    plan: 'agency',
  });
  assert.ok(f.find(x => x.check_id === 'C31'), 'C31 must fire when viewport meta missing');
});

// ─── 8-9. Plan-tier ────────────────────────────────────────────────────────

test('checks: free tier runs only 5 priority checks', () => {
  assert.strictEqual(cro.checksPage.PRIORITY_FREE_SET.length, 5);
});

test('checks: growth tier has 10+ checks', () => {
  assert.ok(cro.checksPage.PRIORITY_GROWTH_SET.length >= 10);
});

// ─── 10. Findings include time_to_fix_minutes ──────────────────────────────

test('checks: each finding has time_to_fix_minutes (SMB-calibrated)', () => {
  const f = cro.checksPage.runChecks({
    html: '<html><body></body></html>',
    text: '', business: {},
    marketProfile: cro.i18nCro.buildCroMarketProfile({}),
    plan: 'agency',
  });
  for (const finding of f) {
    assert.ok(Number.isFinite(finding.time_to_fix_minutes), `finding ${finding.check_id} missing time_to_fix_minutes`);
    assert.ok(finding.time_to_fix_minutes <= 120, 'fix should be ≤2 hours');
  }
});

// ─── 11-13. Scoring ────────────────────────────────────────────────────────

test('scoring: computeScore returns 0-100 and dimension breakdown', () => {
  const r = cro.scoring.computeScore({ findings: [] });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(r.dimensions.above_the_fold === 100, 'no findings → all dims at 100');
});

test('scoring: critical issue penalizes its dimension', () => {
  const r = cro.scoring.computeScore({
    findings: [{ dimension: 'primary_cta', severity: 'critical' }],
  });
  assert.ok(r.dimensions.primary_cta < 100);
});

test('scoring: bandForScore + expectedLiftBand work', () => {
  assert.strictEqual(cro.scoring.bandForScore(85), 'strong');
  assert.strictEqual(cro.scoring.bandForScore(60), 'average');
  assert.strictEqual(cro.scoring.bandForScore(30), 'low');
  assert.strictEqual(cro.scoring.expectedLiftBand({ score: 30, criticalCount: 4 }), 'high');
  assert.strictEqual(cro.scoring.expectedLiftBand({ score: 80, criticalCount: 0 }), 'low');
});

// ─── 14-15. Schema ─────────────────────────────────────────────────────────

test('schema-validate: rejects audit_score out of range', () => {
  const r = cro.schema.validateAudit({ audit_score: 200 });
  assert.strictEqual(r.valid, false);
});

test('schema-validate: accepts valid audit', () => {
  const r = cro.schema.validateAudit({
    audit_score: 65,
    dimension_scores: { primary_cta: 70 },
    critical_issues: [],
    current_estimated_conv_rate_band: 'average',
    expected_lift_band: 'medium',
  });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.normalized.audit_score, 65);
});

// ─── 16-18. End-to-end ─────────────────────────────────────────────────────

test('auditPage: short-circuits with no content', async () => {
  let claudeCalled = false;
  const r = await cro.auditPage({
    business: { business_name: 'Test', plan: 'free' },
    html: '',
    text: '',
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.short_circuited, true);
});

test('auditPage: produces baseline + LLM-merged result with content', async () => {
  const html = '<html><body><h1>Welcome</h1></body></html>';
  const r = await cro.auditPage({
    business: { business_name: 'Test', plan: 'agency' },
    html,
    text: 'Welcome to our site',
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      audit_score: 45,
      dimension_scores: { primary_cta: 20 },
      critical_issues: [{ id: 'C11', severity: 'critical', fix: 'Add a button', time_to_fix_minutes: 15 }],
      warnings: [],
      opportunities: [],
      primary_language: 'en',
      country: 'US',
      current_estimated_conv_rate_band: 'low',
      expected_lift_band: 'high',
      citations: [],
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.short_circuited, false);
  assert.ok(r.audit_score > 0 && r.audit_score < 100);
  assert.ok(Array.isArray(r.deterministic_findings));
});

test('rewritePage: free tier returns deterministic-only template', async () => {
  let claudeCalled = false;
  const r = await cro.rewritePage({
    business: { business_name: 'Cafe Petit', primary_language: 'sq' },
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'free tier should NOT call LLM');
  assert.strictEqual(r.llm_used, false);
  assert.strictEqual(r.deterministic_only, true);
});
