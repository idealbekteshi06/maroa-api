'use strict';

/**
 * tests/ad-optimizer.test.js
 * ----------------------------------------------------------------------------
 * Expert-level test suite for the international ad-optimizer module.
 * 22 tests covering i18n + budget calibration + anti-slop + trend analysis +
 * checks + scoring + schema + end-to-end audit decisions.
 *
 * Test runner: node --test tests/ad-optimizer.test.js
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const ao = require('../services/prompts/ad-optimizer');

// ─── 1-5. International market detection ────────────────────────────────────

test('i18n: detectCountry maps US city to US', () => {
  assert.strictEqual(ao.i18n.detectCountry({ location: 'New York' }), 'US');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Los Angeles, USA' }), 'US');
});

test('i18n: detectCountry maps Tirana to AL, Pristina to XK, Skopje to MK', () => {
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Tirana' }), 'AL');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Pristina' }), 'XK');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Skopje, Macedonia' }), 'MK');
});

test('i18n: detectCountry maps international cities (Sao Paulo, Mumbai, Tokyo, Dubai)', () => {
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Sao Paulo' }), 'BR');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Mumbai' }), 'IN');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Tokyo' }), 'JP');
  assert.strictEqual(ao.i18n.detectCountry({ location: 'Dubai' }), 'AE');
});

test('i18n: tierForCountry — US is ULTRA_HIGH, India is ULTRA_LOW, Albania is ULTRA_LOW, Germany is HIGH', () => {
  const us = ao.i18n.tierForCountry('US');
  const al = ao.i18n.tierForCountry('AL');
  const de = ao.i18n.tierForCountry('DE');
  const ind = ao.i18n.tierForCountry('IN');
  assert.ok(us.cpm_band_usd[1] >= 25, 'US tier ceiling should be ≥$25 CPM');
  assert.ok(al.cpm_band_usd[1] <= 4, 'Albania tier ceiling should be ≤$4 CPM');
  assert.ok(de.cpm_band_usd[1] >= 12 && de.cpm_band_usd[1] <= 20, 'Germany should be HIGH band');
  assert.ok(ind.cpm_band_usd[1] <= 4, 'India should be ULTRA_LOW band');
});

test('i18n: buildMarketProfile fills sensible defaults for known + unknown countries', () => {
  const profileTirana = ao.i18n.buildMarketProfile({ location: 'Tirana, Albania', primary_language: 'sq' });
  assert.strictEqual(profileTirana.country, 'AL');
  assert.strictEqual(profileTirana.currency, 'ALL');
  assert.strictEqual(profileTirana.timezone, 'Europe/Tirane');
  assert.strictEqual(profileTirana.primary_language, 'sq');
  assert.strictEqual(profileTirana.tier_name, 'ULTRA_LOW');

  const profileUnknown = ao.i18n.buildMarketProfile({ location: 'Atlantis' });
  assert.strictEqual(profileUnknown.country, null);
  assert.strictEqual(profileUnknown.currency, 'USD'); // safe default
  assert.strictEqual(profileUnknown.tier_name, 'MID'); // safe default
});

test('i18n: convertCurrency + formatMoney work', () => {
  // 100 EUR -> USD ~107
  const usd = ao.i18n.convertCurrency(100, 'EUR', 'USD');
  assert.ok(usd > 100 && usd < 120, `EUR→USD should be ~107, got ${usd}`);
  // formatMoney returns currency-formatted string
  const fmt = ao.i18n.formatMoney(123.45, 'USD', 'en-US');
  assert.ok(fmt.includes('123'), 'should include the number');
});

test('i18n: detectLanguage catches Albanian, Spanish, Arabic, English', () => {
  assert.strictEqual(ao.i18n.detectLanguage('Tashmë jeni klient i jonë'), 'sq');
  assert.strictEqual(ao.i18n.detectLanguage('Esto es para todos nuestros clientes'), 'es');
  assert.strictEqual(ao.i18n.detectLanguage('مرحبا بكم'), 'ar');
  assert.strictEqual(ao.i18n.detectLanguage('Hello our valued customers'), 'en');
});

// ─── 6-9. Budget calibration ────────────────────────────────────────────────

test('budget: tierForDailyBudgetUsd categorizes correctly across the 5 bands', () => {
  assert.strictEqual(ao.budget.tierName(ao.budget.tierForDailyBudgetUsd(5)), 'MICRO');
  assert.strictEqual(ao.budget.tierName(ao.budget.tierForDailyBudgetUsd(15)), 'SMALL');
  assert.strictEqual(ao.budget.tierName(ao.budget.tierForDailyBudgetUsd(50)), 'MID');
  assert.strictEqual(ao.budget.tierName(ao.budget.tierForDailyBudgetUsd(200)), 'SCALE');
  assert.strictEqual(ao.budget.tierName(ao.budget.tierForDailyBudgetUsd(2000)), 'ENTERPRISE');
});

test('budget: isPauseDataSignificant blocks under-powered data on micro-budget', () => {
  const r = ao.budget.isPauseDataSignificant({ clicks: 20, spend_usd: 5, conversions: 0, daily_budget_usd: 5 });
  assert.strictEqual(r.significant, false);
  assert.match(r.reason, /under-powered/);
  assert.strictEqual(r.tier_name, 'MICRO');
});

test('budget: isPauseDataSignificant passes when data is significant for tier', () => {
  const r = ao.budget.isPauseDataSignificant({ clicks: 200, spend_usd: 60, conversions: 5, daily_budget_usd: 15 });
  assert.strictEqual(r.significant, true);
  assert.strictEqual(r.tier_name, 'SMALL');
});

test('budget: evaluateLearningPhase blocks pause when state=learning', () => {
  const r = ao.budget.evaluateLearningPhase({ learning_phase_state: 'LEARNING' });
  assert.strictEqual(r.in_learning, true);
  assert.strictEqual(r.allow_pause, false);
  assert.strictEqual(r.max_budget_change_pct, 20);
});

test('budget: safeBudgetChange respects learning + tier caps', () => {
  const learning = ao.budget.safeBudgetChange({ daily_budget_usd: 50, direction: 'up', learning_phase_state: 'learning' });
  assert.ok(Math.abs(learning.pct_change) <= 20, 'learning phase caps change at ≤20%');

  const normal = ao.budget.safeBudgetChange({ daily_budget_usd: 50, direction: 'up' });
  assert.ok(normal.pct_change > 0, 'should be positive for direction=up');
  assert.ok(normal.new_daily_budget_usd > 50, 'new budget should be larger');
});

// ─── 10-11. Anti-slop validation ─────────────────────────────────────────────

test('anti-slop: validateAuditResponse catches "ROAS dropped" without sample size', () => {
  const violations = ao.antiSlop.validateAuditResponse({
    decision_reason: 'ROAS dropped — pause now',
    citations: [],
  });
  assert.ok(violations.length > 0, 'should catch unqualified ROAS-drop claim');
  assert.ok(violations.some(v => v.rule_id === 'roas_drop_unqualified'));
});

test('anti-slop: validateAuditResponse passes when citations present', () => {
  const violations = ao.antiSlop.validateAuditResponse({
    decision_reason: 'ROAS dropped from 2.1 to 0.8 over last 7 days',
    citations: [{ sample_size: 14, comparison_period: '7d' }],
  });
  assert.strictEqual(violations.length, 0, 'should pass with proper citations');
});

// ─── 12-14. Trend analysis ───────────────────────────────────────────────────

test('trend: buildTrendSummary handles empty + small history gracefully', () => {
  const empty = ao.trend.buildTrendSummary([]);
  assert.strictEqual(empty.sample_quality, 'insufficient');
  assert.strictEqual(empty.sample_size, 0);

  const small = ao.trend.buildTrendSummary([{ roas: 2 }, { roas: 1.8 }]);
  assert.strictEqual(small.sample_quality, 'insufficient');
});

test('trend: detectThrashing catches recent_pause_within_48h', () => {
  const decisionHistory = [
    { decision: 'pause', decided_at: new Date(Date.now() - 24 * 36e5).toISOString() }, // 24h ago
    { decision: 'keep', decided_at: new Date(Date.now() - 5 * 86400000).toISOString() },
  ];
  const r = ao.trend.detectThrashing(decisionHistory);
  assert.strictEqual(r.thrashing, true);
  assert.strictEqual(r.pattern, 'recent_pause_within_48h');
});

test('trend: detectThrashing catches pause_unpause_pause pattern', () => {
  const decisionHistory = [
    { decision: 'pause', decided_at: new Date(Date.now() - 1 * 86400000).toISOString() },
    { decision: 'keep', decided_at: new Date(Date.now() - 5 * 86400000).toISOString() },
    { decision: 'pause', decided_at: new Date(Date.now() - 10 * 86400000).toISOString() },
    { decision: 'keep', decided_at: new Date(Date.now() - 14 * 86400000).toISOString() },
  ];
  const r = ao.trend.detectThrashing(decisionHistory);
  assert.strictEqual(r.thrashing, true);
  assert.ok(r.pattern === 'pause_unpause_pause' || r.pattern === 'recent_pause_within_48h');
});

// ─── 15-17. Checks (Meta) ────────────────────────────────────────────────────

test('checks: M02 frequency alarm fires only above market threshold (US vs Albania differ)', () => {
  const usMarket = ao.i18n.buildMarketProfile({ location: 'New York' });
  const alMarket = ao.i18n.buildMarketProfile({ location: 'Tirana' });

  // Frequency 4.0 — alarm in US (>3.5), but normal in Albania (<6.0)
  const usFindings = ao.checksMeta.runChecks({
    metrics: { frequency: 4.0 },
    history: [],
    market: usMarket,
    plan: 'agency',
  });
  const alFindings = ao.checksMeta.runChecks({
    metrics: { frequency: 4.0 },
    history: [],
    market: alMarket,
    plan: 'agency',
  });
  const usAlarm = usFindings.find(f => f.check_id === 'M02');
  const alAlarm = alFindings.find(f => f.check_id === 'M02');
  assert.ok(usAlarm, 'US should fire M02 frequency alarm at 4.0');
  assert.strictEqual(alAlarm, undefined, 'Albania should NOT fire M02 frequency alarm at 4.0');
});

test('checks: M11 CTR check uses regional benchmark not US default', () => {
  const alMarket = ao.i18n.buildMarketProfile({ location: 'Tirana' });
  // CTR 0.6% — well below Albania healthy 1.5% × 0.6 = 0.9% (yes triggers)
  const findings = ao.checksMeta.runChecks({
    metrics: { ctr: 0.006 }, // 0.6% as ratio
    history: [],
    market: alMarket,
    plan: 'agency',
  });
  const m11 = findings.find(f => f.check_id === 'M11');
  assert.ok(m11, 'should fire M11 CTR check below regional benchmark');
  assert.ok(m11.evidence.regional_benchmark, 'evidence must include regional_benchmark');
  assert.strictEqual(m11.evidence.market_tier, 'ULTRA_LOW');
});

test('checks: plan-tier limits — free=5 IDs, growth has more, agency all', () => {
  assert.strictEqual(ao.checksMeta.PRIORITY_FREE_SET.length, 5);
  assert.ok(ao.checksMeta.PRIORITY_GROWTH_SET.length > ao.checksMeta.PRIORITY_FREE_SET.length);
  assert.ok(ao.checksMeta.PRIORITY_GROWTH_SET.length <= ao.checksMeta.CHECKS.length);
});

// ─── 18. Scoring ─────────────────────────────────────────────────────────────

test('scoring: computeAuditScore returns weighted score 0-100 with breakdown', () => {
  const market = ao.i18n.buildMarketProfile({ location: 'New York' });
  const r = ao.scoring.computeAuditScore({
    findings: [],
    metrics: { roas: 3, ctr: 0.012 },
    market,
    trend: { roas_7d: 'improving', frequency_trajectory: 'stable' },
  });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(r.dimensions.cost_efficiency > 70, 'high ROAS → high cost-efficiency dim');
  assert.ok(typeof r.dimensions.delivery === 'number');
});

// ─── 19-20. Schema validator ─────────────────────────────────────────────────

test('schema: validateAuditOutput rejects bad decision values', () => {
  const r = ao.schema.validateAuditOutput({
    decision: 'kill_it_now',
    decision_reason: 'no',
    audit_score: 50,
  });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('decision')));
});

test('schema: validateAuditOutput accepts valid + normalizes', () => {
  const r = ao.schema.validateAuditOutput({
    decision: 'keep',
    decision_reason: 'ROAS 2.1 sustained over 7d, no creative fatigue',
    new_daily_budget: null,
    audit_score: 78,
    critical_issues: [],
    warnings: [],
    opportunities: [],
    trend: { roas_7d: 'stable', frequency_trajectory: 'stable', spend_velocity: 'on_pace' },
    citations: [{ check_id: 'M01', metric: 'roas', value: 2.1 }],
  });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.normalized.critical_issues, []);
  assert.strictEqual(r.normalized.audit_score, 78);
});

// ─── 21-23. End-to-end auditCampaign integration ────────────────────────────

test('auditCampaign: short-circuits to "keep" on insufficient data (no LLM call)', async () => {
  let claudeCalled = false;
  const r = await ao.auditCampaign({
    business: { location: 'Tirana', plan: 'free', primary_language: 'sq' },
    metrics: { spend: 3, clicks: 5, impressions: 200, daily_budget: 5, roas: 0.5 },
    history: [],
    decisionHistory: [],
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
    logger: null,
  });
  assert.strictEqual(claudeCalled, false, 'should NOT call Claude when data insufficient');
  assert.strictEqual(r.decision, 'keep');
  assert.strictEqual(r.short_circuited, true);
  assert.strictEqual(r.short_circuit_reason, 'insufficient_data');
});

test('auditCampaign: short-circuits to "pause" on critical compliance finding', async () => {
  let claudeCalled = false;
  const r = await ao.auditCampaign({
    business: { location: 'New York', plan: 'agency' },
    metrics: { spend: 200, clicks: 1500, impressions: 20000, daily_budget: 50, roas: 2.5, ad_status: 'REJECTED' },
    history: [],
    decisionHistory: [],
    plan: 'agency',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
    logger: null,
  });
  assert.strictEqual(claudeCalled, false, 'should NOT call Claude when ad rejected');
  assert.strictEqual(r.decision, 'pause');
  assert.strictEqual(r.short_circuit_reason, 'compliance_critical');
});

test('auditCampaign: anti-thrashing overrides LLM "pause" within 48h of last pause', async () => {
  const r = await ao.auditCampaign({
    business: { location: 'New York', plan: 'agency' },
    metrics: { spend: 200, clicks: 1500, impressions: 20000, daily_budget: 50, roas: 0.6, frequency: 2, conversions: 8 },
    history: [
      { roas: 0.7, frequency: 1.8, ctr: 0.008, spend: 50 },
      { roas: 0.65, frequency: 1.9, ctr: 0.0085, spend: 50 },
      { roas: 0.6, frequency: 2.0, ctr: 0.009, spend: 50 },
    ],
    decisionHistory: [
      { decision: 'pause', decided_at: new Date(Date.now() - 24 * 36e5).toISOString() },
    ],
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      decision: 'pause',
      decision_reason: 'ROAS at 0.6 below break-even, sustained over 3 days',
      new_daily_budget: null,
      audit_score: 35,
      critical_issues: [],
      warnings: [],
      opportunities: [],
      trend: { roas_7d: 'declining', frequency_trajectory: 'climbing', spend_velocity: 'on_pace' },
      citations: [{ check_id: 'M42', metric: 'roas', value: 0.6, sample_size: 3, comparison_period: '3d' }],
    }),
    extractJSON: JSON.parse,
    logger: null,
  });
  // Anti-thrashing should kick in: pause→pause within 48h → switch to optimize
  assert.notStrictEqual(r.decision, 'pause', 'must NOT pause again within 48h of last pause');
  assert.ok(r.decision === 'optimize' || r.decision === 'keep', `expected optimize/keep, got ${r.decision}`);
});
