'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dn = require('../services/prompts/decision-narrator');

// ─── Validation ───────────────────────────────────────────────────────────

test('validateNarrative: skip=true returns valid with skip flag', () => {
  const v = dn.validateNarrative({ skip: true, reason: 'insufficient_evidence' });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.skip, true);
});

test('validateNarrative: rejects non-object input', () => {
  assert.strictEqual(dn.validateNarrative(null).valid, false);
  assert.strictEqual(dn.validateNarrative('string').valid, false);
});

test('validateNarrative: rejects invalid confidence value', () => {
  const v = dn.validateNarrative({
    what_we_saw: 'X',
    why_we_chose: 'Y',
    narrative_full: 'Z.',
    confidence: 'super-high',
  });
  assert.strictEqual(v.valid, false);
});

test('validateNarrative: rejects narrative >5 sentences', () => {
  const v = dn.validateNarrative({
    what_we_saw: 'X.',
    why_we_chose: 'Y.',
    narrative_full: 'One. Two. Three. Four. Five. Six. Seven.',
    confidence: 'high',
  });
  assert.strictEqual(v.valid, false);
});

test('validateNarrative: accepts valid + normalizes', () => {
  const v = dn.validateNarrative({
    what_we_saw: 'ROAS fell to 1.8.',
    what_we_considered: 'Pause vs keep.',
    why_we_chose: 'Learning phase active.',
    confidence: 'medium',
    confidence_reason: '14d data, but variance high.',
    what_we_expect: 'Stabilizes ≥2.0 in 5d.',
    narrative_full: 'ROAS fell. We considered pause. Learning phase active. Keep 5 more days. Re-decide if drops <1.5.',
  });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.normalized.confidence, 'medium');
});

test('countSentences counts correctly', () => {
  assert.strictEqual(dn.countSentences('One. Two. Three.'), 3);
  assert.strictEqual(dn.countSentences('No periods'), 0);
  assert.strictEqual(dn.countSentences('Question? Yes! Period.'), 3);
});

// ─── narrate() end-to-end ─────────────────────────────────────────────────

test('narrate: free tier skips (cost protection)', async () => {
  let claudeCalled = false;
  const r = await dn.narrate({
    decision: { action: 'pause' },
    context: { findings: [{ check_id: 'M02' }] },
    business: { plan: 'free' },
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r, null);
});

test('narrate: refuses with no evidence (honest skip)', async () => {
  let claudeCalled = false;
  const r = await dn.narrate({
    decision: { action: 'pause' },
    context: {}, // no findings, no metrics, no trend
    business: { plan: 'agency' },
    plan: 'agency',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'no LLM call when no evidence');
  assert.strictEqual(r, null);
});

test('narrate: agency tier produces full narrative', async () => {
  const r = await dn.narrate({
    decision: { action: 'keep', audit_score: 65 },
    context: {
      findings: [{ check_id: 'M02', severity: 'warning' }],
      trend: { roas_7d: 'declining', frequency_trajectory: 'climbing' },
      gates: { in_learning: true },
    },
    business: { business_name: 'Cafe Petit', plan: 'agency', location: 'Tirana' },
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      what_we_saw: 'ROAS fell to 1.8 over 14d, frequency climbing.',
      what_we_considered: 'Pausing vs keeping.',
      why_we_chose: 'Still in learning phase.',
      confidence: 'medium',
      confidence_reason: '14d data, learning gate active.',
      what_we_expect: 'ROAS stabilizes ≥2.0 in 5 days.',
      narrative_full: 'ROAS fell to 1.8 over 14d. We considered pausing. Still in learning phase. Keep 5 more days. Re-decide if drops <1.5.',
    }),
    extractJSON: JSON.parse,
  });
  assert.ok(r);
  assert.strictEqual(r.confidence, 'medium');
  assert.match(r.narrative_full, /ROAS/);
});

test('narrate: returns null on malformed LLM output', async () => {
  const r = await dn.narrate({
    decision: { action: 'pause' },
    context: { findings: [{ check_id: 'M01' }] },
    business: { plan: 'agency' },
    plan: 'agency',
    callClaude: async () => 'not json',
    extractJSON: () => { throw new Error('parse'); },
  });
  assert.strictEqual(r, null);
});

test('narrate: handles LLM skip-with-reason response', async () => {
  const r = await dn.narrate({
    decision: { action: 'keep' },
    context: { findings: [{ check_id: 'M01' }] },
    business: { plan: 'agency' },
    plan: 'agency',
    callClaude: async () => JSON.stringify({ skip: true, reason: 'insufficient_evidence' }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r, null);
});

// ─── Convenience wrappers ─────────────────────────────────────────────────

test('narrateAdDecision: bridges audit shape to narrate()', async () => {
  let userMessageSeen = '';
  const r = await dn.narrateAdDecision(
    {
      decision: 'scale',
      decision_reason: 'ROAS strong',
      audit_score: 88,
      deterministic_findings: [{ check_id: 'M41' }],
      trend: { roas_7d: 'improving' },
      gates: { in_learning: false },
      citations: [{ check_id: 'M41', metric: 'roas', value: 3.2 }],
    },
    { plan: 'agency', business_name: 'X' },
    'agency',
    {
      callClaude: async (opts) => {
        userMessageSeen = opts.user;
        return JSON.stringify({
          what_we_saw: 'ROAS 3.2 over 14d.',
          what_we_considered: 'Hold vs scale.',
          why_we_chose: 'Sustained trend.',
          confidence: 'high',
          confidence_reason: '14d strong data.',
          what_we_expect: '+15% revenue if budget +20%.',
          narrative_full: 'ROAS 3.2 over 14d. We considered holding. Sustained trend. Scale +20%. Re-check in 7d.',
        });
      },
      extractJSON: JSON.parse,
    }
  );
  assert.ok(r);
  assert.match(userMessageSeen, /M41/);
  assert.strictEqual(r.confidence, 'high');
});

test('narrateSeoDecision: passes audit findings as context', async () => {
  const r = await dn.narrateSeoDecision(
    {
      ai_search_readiness: 'minimal',
      audit_score: 35,
      estimated_citation_potential: 'low',
      deterministic_findings: [{ check_id: 'S01' }],
      critical_gaps: [{ id: 'S01' }],
      dimension_scores: { schema_markup: 10 },
      citations: [],
    },
    { plan: 'growth', business_name: 'X' },
    'growth',
    {
      callClaude: async () => JSON.stringify({
        what_we_saw: 'No JSON-LD detected, schema_markup 10/100.',
        what_we_considered: 'Different fixes ranked.',
        why_we_chose: 'Add Organization schema first.',
        confidence: 'high',
        confidence_reason: 'Findings concrete.',
        what_we_expect: 'AI-search readiness goes minimal→partial in 1 fix.',
        narrative_full: 'No JSON-LD found. Schema_markup at 10/100. Highest-ROI fix: Organization schema. Ship in 30min. Re-audit after.',
      }),
      extractJSON: JSON.parse,
    }
  );
  assert.ok(r);
  assert.strictEqual(r.confidence, 'high');
});

test('narrateCroDecision: handles CRO audit shape', async () => {
  const r = await dn.narrateCroDecision(
    {
      audit_score: 42,
      expected_lift_band: 'high',
      current_estimated_conv_rate_band: 'low',
      deterministic_findings: [{ check_id: 'C01' }, { check_id: 'C11' }],
      critical_issues: [{ id: 'C01' }],
      warnings: [],
      dimension_scores: { primary_cta: 20 },
      citations: [],
    },
    { plan: 'agency', business_name: 'X' },
    'agency',
    {
      callClaude: async () => JSON.stringify({
        what_we_saw: 'No H1, no CTA, primary_cta=20/100.',
        what_we_considered: 'Quick wins vs deep restructure.',
        why_we_chose: 'Quick wins first.',
        confidence: 'high',
        confidence_reason: 'Critical fundamentals missing.',
        what_we_expect: 'Conv lift 30%+ once H1 + CTA added.',
        narrative_full: 'No H1, no CTA. Primary_CTA at 20/100. Add both first. Expected conv lift 30%. Re-audit in 7d.',
      }),
      extractJSON: JSON.parse,
    }
  );
  assert.ok(r);
});

test('narrateForecastDecision: handles forecast shape with metrics', async () => {
  const r = await dn.narrateForecastDecision(
    {
      horizon_days: 60,
      data_quality: 'good',
      roas_forecast: { low: 1.8, mid: 2.4, high: 3.0, confidence: 'medium' },
      revenue_forecast: { low: 8000, mid: 12000, high: 16000 },
      ltv_forecast: { value: 280 },
      sample_size_days: 45,
      caveats: [],
      budget_allocation_recommendation: { current: { meta: 50 }, recommended: { meta: 60 }, expected_lift_pct: 0.12 },
    },
    { plan: 'agency', business_name: 'X' },
    'agency',
    {
      callClaude: async () => JSON.stringify({
        what_we_saw: 'ROAS forecast 1.8-3.0 over 60d, 45d data.',
        what_we_considered: 'Hold budget vs reallocate.',
        why_we_chose: 'Reallocate +12% lift.',
        confidence: 'medium',
        confidence_reason: '45d data, medium R².',
        what_we_expect: 'Revenue 8k-16k, mid 12k.',
        narrative_full: 'ROAS forecast 1.8-3.0 over 60d. We considered hold. Reallocation +12%. Revenue 8k-16k. Re-forecast in 30d.',
      }),
      extractJSON: JSON.parse,
    }
  );
  assert.ok(r);
});
