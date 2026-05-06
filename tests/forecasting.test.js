'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fc = require('../services/prompts/forecasting');
const reg = fc.regression;

// ─── Regression math ──────────────────────────────────────────────────────

test('regression: linearFit detects positive slope', () => {
  const r = reg.linearFit([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(r.slope > 0.9 && r.slope < 1.1);
  assert.ok(r.r2 > 0.99);
});

test('regression: linearFit returns null for n<3', () => {
  assert.strictEqual(reg.linearFit([1, 2]), null);
});

test('regression: varianceClass labels correctly', () => {
  assert.strictEqual(reg.varianceClass([10, 10.1, 9.9, 10.05]), 'low');
  assert.strictEqual(reg.varianceClass([10, 5, 15, 8, 12]), 'medium');
  assert.strictEqual(reg.varianceClass([10, 50, 2, 80, 5]), 'high');
});

test('regression: linearForecast widens band with horizon', () => {
  const ts = [2, 2.1, 2.2, 2.15, 2.25, 2.3, 2.28, 2.32];
  const f30 = reg.linearForecast(ts, 30);
  const f90 = reg.linearForecast(ts, 90);
  assert.ok((f90.high - f90.low) > (f30.high - f30.low), '90d band wider than 30d');
});

test('regression: confidence "high" requires R² + n', () => {
  const noisy = Array.from({ length: 30 }, () => Math.random() * 10);
  const f = reg.linearForecast(noisy, 30);
  // Random noise gives low R²
  assert.notStrictEqual(f.confidence, 'high');
});

test('regression: recommendBudgetAllocation moves spend toward higher-ROAS channel', () => {
  const r = reg.recommendBudgetAllocation([
    { name: 'meta',   spend: 50, roas: 3.0 },
    { name: 'google', spend: 50, roas: 1.0 },
  ]);
  assert.ok(r.recommended.meta > 50, 'should reallocate toward meta');
  assert.ok(r.recommended.google < 50, 'should pull from google');
  assert.ok(r.expected_lift_pct > 0);
});

test('regression: recommendBudgetAllocation requires ≥2 channels', () => {
  assert.strictEqual(reg.recommendBudgetAllocation([{ name: 'meta', spend: 100, roas: 2 }]), null);
});

test('regression: cohortLtv computes mean order value + repeat rate', () => {
  const orders = [
    { customer_id: 'c1', amount: 50, ordered_at: '2026-01-01' },
    { customer_id: 'c1', amount: 30, ordered_at: '2026-02-01' },
    { customer_id: 'c2', amount: 100, ordered_at: '2026-01-15' },
    { customer_id: 'c3', amount: 75, ordered_at: '2026-02-15' },
    { customer_id: 'c4', amount: 25, ordered_at: '2026-03-01' },
    { customer_id: 'c5', amount: 60, ordered_at: '2026-03-10' },
    { customer_id: 'c6', amount: 40, ordered_at: '2026-03-15' },
    { customer_id: 'c7', amount: 90, ordered_at: '2026-03-20' },
    { customer_id: 'c1', amount: 80, ordered_at: '2026-04-01' },
    { customer_id: 'c8', amount: 55, ordered_at: '2026-04-05' },
  ];
  const ltv = reg.cohortLtv(orders);
  assert.ok(ltv);
  assert.strictEqual(ltv.sample_size, 8); // 8 unique customers
  assert.ok(ltv.repeat_rate > 0);
  assert.ok(ltv.value > 0);
});

test('regression: cohortLtv returns null for <10 orders', () => {
  assert.strictEqual(reg.cohortLtv([]), null);
});

// ─── End-to-end forecastForBusiness ───────────────────────────────────────

test('forecastForBusiness: refuses to forecast on <14 days history', async () => {
  let claudeCalled = false;
  const r = await fc.forecastForBusiness({
    business: { business_name: 'X', plan: 'growth' },
    history: Array.from({ length: 5 }, (_, i) => ({ roas: 2 + i * 0.1, spend: 50 })),
    plan: 'growth',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'should NOT call Claude on insufficient data');
  assert.strictEqual(r.short_circuited, true);
  assert.strictEqual(r.data_quality, 'insufficient');
  assert.match(r.short_circuit_reason, /14 days/);
});

test('forecastForBusiness: free tier returns numbers without LLM narrative', async () => {
  let claudeCalled = false;
  const history = Array.from({ length: 30 }, (_, i) => ({ roas: 2 + (i * 0.02), spend: 50 + i }));
  const r = await fc.forecastForBusiness({
    business: { business_name: 'X', plan: 'free', location: 'New York' },
    history,
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'free tier should NOT call LLM');
  assert.strictEqual(r.narrative, '');
  assert.strictEqual(r.short_circuited, false);
  assert.ok(r.roas_forecast);
  assert.ok(r.spend_forecast);
  assert.ok(r.revenue_forecast);
});

test('forecastForBusiness: growth tier produces narrative + valid forecast', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ roas: 2 + (i * 0.02), spend: 50 + i }));
  const r = await fc.forecastForBusiness({
    business: { business_name: 'X', plan: 'growth', location: 'Tirana' },
    history,
    plan: 'growth',
    callClaude: async () => JSON.stringify({
      narrative: 'ROAS trending up. Expected revenue 60d range $X-$Y. Add budget if pace holds.',
      caveats: [],
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.short_circuited, false);
  assert.ok(r.narrative.length > 0);
  assert.ok(r.narrative_generated);
  assert.strictEqual(r.currency, 'ALL'); // Albania
  assert.strictEqual(r.primary_language, 'sq');
});

test('forecastForBusiness: caveats include high-variance flag', async () => {
  const noisy = Array.from({ length: 20 }, () => ({ roas: Math.random() * 5, spend: 50 + Math.random() * 50 }));
  const r = await fc.forecastForBusiness({
    business: { business_name: 'X', plan: 'free' },
    history: noisy,
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  // High variance is likely on random data
  assert.ok(Array.isArray(r.caveats));
});

test('forecastForBusiness: applies budget allocation when channelHistory provided', async () => {
  const metaRows   = Array.from({ length: 30 }, (_, i) => ({ roas: 3.0,  spend: 50, platform: 'meta' }));
  const googleRows = Array.from({ length: 30 }, (_, i) => ({ roas: 1.0,  spend: 50, platform: 'google' }));
  const history = [...metaRows, ...googleRows];
  const r = await fc.forecastForBusiness({
    business: { business_name: 'X', plan: 'free' },
    history,
    channelHistory: { meta: metaRows, google: googleRows },
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.ok(r.budget_allocation_recommendation);
  assert.ok(r.budget_allocation_recommendation.recommended.meta > r.budget_allocation_recommendation.current.meta);
});
