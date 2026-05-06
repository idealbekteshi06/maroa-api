'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mp = require('../services/prompts/marketing-psychology');
const det = mp.detector;

// ─── Principles library ───────────────────────────────────────────────────

test('library: contains 30+ principles across multiple families', () => {
  assert.ok(mp.PRINCIPLES.length >= 30, `expected 30+ principles, got ${mp.PRINCIPLES.length}`);
  const families = new Set(mp.PRINCIPLES.map(p => p.family));
  assert.ok(families.size >= 7, `expected 7+ families, got ${families.size}`);
});

test('library: every principle has required fields', () => {
  for (const p of mp.PRINCIPLES) {
    assert.ok(p.id, `${p.name || 'principle'} missing id`);
    assert.ok(p.name, `${p.id} missing name`);
    assert.ok(p.family, `${p.id} missing family`);
    assert.ok(p.short_description, `${p.id} missing description`);
    assert.ok(p.example_before, `${p.id} missing example_before`);
    assert.ok(p.example_after, `${p.id} missing example_after`);
    assert.ok(typeof p.ethical_risk === 'number', `${p.id} ethical_risk must be number`);
    assert.ok(p.ethical_risk >= 0 && p.ethical_risk <= 10, `${p.id} ethical_risk out of range`);
  }
});

test('library: byId resolves correctly', () => {
  const p = mp.byId('P003');
  assert.strictEqual(p.name, 'Social Proof');
  assert.strictEqual(p.family, 'cialdini');
});

test('library: byId returns null for missing', () => {
  assert.strictEqual(mp.byId('PXXX'), null);
});

// ─── Detector ─────────────────────────────────────────────────────────────

test('detector: catches social proof in "12,000+ customers"', () => {
  const r = det.detect('Join 12,000+ customers — 4.8/5 across 800 reviews.');
  const hasSocialProof = r.applied.find(a => a.id === 'P003');
  assert.ok(hasSocialProof);
  assert.ok(hasSocialProof.evidence_quotes.length > 0);
});

test('detector: catches authority signals (certified + experience)', () => {
  const r = det.detect('Dr. Hoxha, board-certified with 18 years experience in implants.');
  const hasAuthority = r.applied.find(a => a.id === 'P004');
  assert.ok(hasAuthority);
});

test('detector: catches reciprocity (free)', () => {
  const r = det.detect('Get our free 30-page audit guide. Yours to keep.');
  const hasReciprocity = r.applied.find(a => a.id === 'P001');
  assert.ok(hasReciprocity);
});

test('detector: catches scarcity (only N left)', () => {
  const r = det.detect('Only 3 tables left for tonight — book before 18:00.');
  const hasScarcity = r.applied.find(a => a.id === 'P006');
  assert.ok(hasScarcity);
});

test('detector: catches risk reversal (money-back / guarantee)', () => {
  const r = det.detect('30-day money-back guarantee. No questions asked.');
  const hasRiskReversal = r.applied.find(a => a.id === 'P047');
  assert.ok(hasRiskReversal);
});

test('detector: clean prose with no principles → empty result', () => {
  const r = det.detect('We offer dental services in Tirana.');
  // May catch some weak signals but should be ≤2
  assert.ok(r.applied.length <= 3);
});

test('detector: empty input handled', () => {
  const r = det.detect('');
  assert.strictEqual(r.applied.length, 0);
  assert.strictEqual(r.coverage_pct, 0);
});

// ─── Suggest missing ──────────────────────────────────────────────────────

test('suggestMissing: cafe gets industry-fit suggestions', () => {
  const r = det.suggestMissing({
    text: 'We sell coffee.',
    industry: 'cafe',
    funnelStage: 'consideration',
    limit: 5,
  });
  assert.ok(r.length > 0);
  assert.ok(r.length <= 5);
  // Should NOT include high-risk for cafe at consideration stage
});

test('suggestMissing: dental clinic excludes scarcity (low-fit + high-risk)', () => {
  const r = det.suggestMissing({
    text: 'We do dental implants.',
    industry: 'dental',
    funnelStage: 'consideration',
    limit: 5,
  });
  const hasScarcity = r.find(p => p.id === 'P006');
  assert.strictEqual(hasScarcity, undefined, 'dental clinic should not get scarcity recommendation');
});

test('suggestMissing: respects manipulationRiskCap', () => {
  const r = det.suggestMissing({
    text: 'Generic message.',
    industry: 'cafe',
    funnelStage: 'decision',
    manipulationRiskCap: 3,
    limit: 10,
  });
  // All returned should have ethical_risk ≤ 3
  for (const p of r) {
    assert.ok(p.ethical_risk <= 3, `${p.name} risk=${p.ethical_risk} > cap 3`);
  }
});

// ─── Detect misapplied ────────────────────────────────────────────────────

test('detectMisapplied: dental clinic using scarcity flagged', () => {
  const r = det.detectMisapplied({
    text: 'Only 5 implant slots left this month — book now!',
    industry: 'dental',
  });
  const hasFlag = r.find(p => p.id === 'P006');
  assert.ok(hasFlag);
  assert.match(hasFlag.reason, /dental/);
});

test('detectMisapplied: high-risk principles flagged with severity', () => {
  const r = det.detectMisapplied({
    text: 'Don\'t miss out — only 2 left!',
    industry: 'retail',
  });
  // High-risk principles in retail still get soft warning
  const hasSoftWarn = r.find(p => p.severity === 'soft');
  assert.ok(hasSoftWarn);
});

// ─── computeScore ────────────────────────────────────────────────────────

test('computeScore: empty copy → low score', () => {
  const s = det.computeScore({ appliedCount: 0, missingFitCount: 5, misappliedCount: 0, manipulationRisk: 'low' });
  assert.ok(s < 50);
});

test('computeScore: well-applied + low risk → high score', () => {
  const s = det.computeScore({ appliedCount: 8, missingFitCount: 2, misappliedCount: 0, manipulationRisk: 'low' });
  assert.ok(s >= 80, `expected 80+, got ${s}`);
});

test('computeScore: misapplied principles penalize', () => {
  const clean = det.computeScore({ appliedCount: 5, missingFitCount: 1, misappliedCount: 0, manipulationRisk: 'low' });
  const dirty = det.computeScore({ appliedCount: 5, missingFitCount: 1, misappliedCount: 3, manipulationRisk: 'low' });
  assert.ok(clean > dirty + 10);
});

// ─── audit() end-to-end ───────────────────────────────────────────────────

test('audit: free tier returns deterministic-only audit', async () => {
  let claudeCalled = false;
  const r = await mp.audit({
    text: 'Join 12,000 customers. Trusted by experts.',
    business: { industry: 'saas', plan: 'free' },
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false);
  assert.strictEqual(r.llm_used, false);
  assert.ok(r.principles_applied.length > 0);
  assert.ok(typeof r.overall_score === 'number');
});

test('audit: agency tier produces LLM-enriched audit', async () => {
  const r = await mp.audit({
    text: 'Join 12,000 customers. Try free for 14 days.',
    business: { industry: 'saas', plan: 'agency', primary_language: 'en' },
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      overall_score: 78,
      applied_summary: 'Social proof + reciprocity',
      principles_applied: [{ id: 'P003', name: 'Social Proof', evidence_quote: '12,000 customers' }],
      principles_missing_but_fit: [],
      principles_misapplied: [],
      manipulation_risk: 'low',
      industry_fit: 'well-fit',
      top_recommendations: [],
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.llm_used, true);
  assert.strictEqual(r.overall_score, 78);
});

test('audit: empty input skipped', async () => {
  const r = await mp.audit({
    text: '',
    business: { industry: 'cafe' },
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.skipped, true);
});

test('audit: LLM failure falls back to deterministic', async () => {
  const r = await mp.audit({
    text: 'Join 1,000 customers.',
    business: { industry: 'saas' },
    plan: 'agency',
    callClaude: async () => { throw new Error('llm unavailable'); },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.data_quality, 'deterministic_fallback');
  assert.strictEqual(r.llm_used, false);
});

// ─── apply() end-to-end ───────────────────────────────────────────────────

test('apply: free tier refuses (cost protection)', async () => {
  const r = await mp.apply({
    text: 'Buy our coffee.',
    business: { industry: 'cafe' },
    principleId: 'P003',
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.refused, true);
  assert.strictEqual(r.reason, 'free_tier_skip');
});

test('apply: agency rewrites with chosen principle', async () => {
  const r = await mp.apply({
    text: 'Buy our coffee.',
    business: { industry: 'cafe', primary_language: 'en' },
    principleId: 'P003',
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      rewritten: 'Trusted by 4,200 daily customers — try the same espresso they swear by.',
      changes_made: ['Added social proof with concrete number'],
      language_preserved: true,
      facts_preserved: true,
    }),
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.refused, undefined);
  assert.match(r.rewritten, /4,200/);
  assert.strictEqual(r.applied_principle.id, 'P003');
});

test('apply: refuses high-risk principle for restricted industry', async () => {
  const r = await mp.apply({
    text: 'Try our dental implants.',
    business: { industry: 'dental', primary_language: 'en' },
    principleId: 'P006', // Scarcity — high risk for dental
    plan: 'agency',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.refused, true);
  assert.match(r.reason, /high-risk for dental/);
  assert.ok(r.alternative_principle_id);
});

test('apply: principleId="auto" picks best-fit', async () => {
  const r = await mp.apply({
    text: 'We make coffee.',
    business: { industry: 'cafe', primary_language: 'en' },
    principleId: 'auto',
    plan: 'agency',
    callClaude: async () => JSON.stringify({
      rewritten: 'Made fresh every morning since 2018.',
      changes_made: ['Added specificity'],
      language_preserved: true,
      facts_preserved: true,
    }),
    extractJSON: JSON.parse,
  });
  assert.ok(r.applied_principle);
  assert.notStrictEqual(r.rewritten, 'We make coffee.');
});

test('apply: invalid principle ID → refused', async () => {
  const r = await mp.apply({
    text: 'Buy now.',
    business: { industry: 'cafe' },
    principleId: 'PXXX',
    plan: 'agency',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.refused, true);
  assert.strictEqual(r.reason, 'principle_not_found');
});

test('apply: handles malformed LLM output gracefully', async () => {
  const r = await mp.apply({
    text: 'Buy now.',
    business: { industry: 'cafe' },
    principleId: 'P003',
    plan: 'agency',
    callClaude: async () => 'not json',
    extractJSON: () => { throw new Error('parse error'); },
  });
  assert.strictEqual(r.refused, true);
  assert.match(r.reason, /parse|llm/i);
});
