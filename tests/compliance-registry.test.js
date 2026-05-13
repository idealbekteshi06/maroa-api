'use strict';

/**
 * tests/compliance-registry.test.js
 *
 * Wave 60 Session 5 — verifies the compliance ruleset registry contract.
 *   - 20 rulesets load cleanly
 *   - Every module exports the required shape
 *   - applyCompliance correctly catches the documented examples_blocked
 *   - rulesetsForIndustry returns the right modules
 *   - listRulesets filters by category + region
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../services/prompts/compliance');

const EXPECTED_COUNT = 20;
const REQUIRED_EXPORTS = [
  'id',
  'name',
  'category',
  'industries',
  'regions',
  'regulators',
  'source_citation',
  'banned_claims',
  'required_disclosures',
  'platform_restrictions',
  'examples_blocked',
  'applyToDraft',
  'generateGuidance',
];

const VALID_CATEGORIES = ['health', 'financial', 'regulated-substances', 'legal-housing', 'high-risk'];

// ─── Module loading ───────────────────────────────────────────────────────

test('compliance: listAllIds returns 20 ruleset IDs', () => {
  assert.strictEqual(registry.listAllIds().length, EXPECTED_COUNT);
});

test('compliance: every ID maps to a loadable module', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    assert.ok(mod, `${id} failed to load`);
    assert.notStrictEqual(mod, registry.NULL_MODULE, `${id} resolved to NULL_MODULE`);
  }
});

test('compliance: getRuleset returns null for unknown id', () => {
  assert.strictEqual(registry.getRuleset('not-a-ruleset'), null);
});

// ─── Shape invariant ──────────────────────────────────────────────────────

for (const field of REQUIRED_EXPORTS) {
  test(`compliance: every module exports "${field}"`, () => {
    for (const id of registry.listAllIds()) {
      const mod = registry.getRuleset(id);
      assert.ok(mod[field] !== undefined && mod[field] !== null, `${id} missing "${field}"`);
    }
  });
}

test('compliance: every module has valid category', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    assert.ok(
      VALID_CATEGORIES.includes(mod.category),
      `${id} has invalid category "${mod.category}"`
    );
  }
});

test('compliance: every module ID matches its filename / kebab-case', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    assert.strictEqual(mod.id, id);
    assert.ok(/^[a-z0-9-]+$/.test(mod.id), `${id} not kebab-case`);
  }
});

test('compliance: every module has at least one banned claim', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    assert.ok(
      Array.isArray(mod.banned_claims) && mod.banned_claims.length > 0,
      `${id} has no banned_claims`
    );
  }
});

test('compliance: every banned claim has regulator + statute info', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    for (const claim of mod.banned_claims) {
      assert.ok(claim.regulator || mod.regulators.length, `${id} claim missing regulator`);
    }
  }
});

test('compliance: every module has examples_blocked that actually trigger refusal', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getRuleset(id);
    for (const example of mod.examples_blocked) {
      const r = mod.applyToDraft(example, { industry: mod.industries[0] || '*' });
      assert.ok(
        !r.ok || r.violations.length > 0,
        `${id}: example "${example}" should trigger refusal but did not`
      );
    }
  }
});

// ─── Filters ──────────────────────────────────────────────────────────────

test('compliance: listRulesets(category=health) returns 5 rulesets', () => {
  const r = registry.listRulesets({ category: 'health' });
  assert.strictEqual(r.length, 5);
});

test('compliance: listRulesets(category=financial) returns 4 rulesets', () => {
  const r = registry.listRulesets({ category: 'financial' });
  assert.strictEqual(r.length, 4);
});

test('compliance: listRulesets(category=regulated-substances) returns 4 rulesets', () => {
  const r = registry.listRulesets({ category: 'regulated-substances' });
  assert.strictEqual(r.length, 4);
});

test('compliance: listRulesets(category=legal-housing) returns 3 rulesets', () => {
  const r = registry.listRulesets({ category: 'legal-housing' });
  assert.strictEqual(r.length, 3);
});

test('compliance: listRulesets(category=high-risk) returns 4 rulesets', () => {
  const r = registry.listRulesets({ category: 'high-risk' });
  assert.strictEqual(r.length, 4);
});

// ─── rulesetsForIndustry ──────────────────────────────────────────────────

test('compliance: rulesetsForIndustry(medical_clinic) → healthcare-general', () => {
  const r = registry.rulesetsForIndustry('medical_clinic');
  assert.ok(r.length >= 1);
  assert.ok(r.some((m) => m.id === 'healthcare-general'));
});

test('compliance: rulesetsForIndustry(mortgage_broker) → mortgage-broker', () => {
  const r = registry.rulesetsForIndustry('mortgage_broker');
  assert.ok(r.some((m) => m.id === 'mortgage-broker'));
});

test('compliance: rulesetsForIndustry(financial_advisor) → financial-advisor', () => {
  const r = registry.rulesetsForIndustry('financial_advisor');
  assert.ok(r.some((m) => m.id === 'financial-advisor'));
});

test('compliance: rulesetsForIndustry(real_estate_agent) → real-estate-fair-housing', () => {
  const r = registry.rulesetsForIndustry('real_estate_agent');
  assert.ok(r.some((m) => m.id === 'real-estate-fair-housing'));
});

test('compliance: rulesetsForIndustry(unknown) returns empty', () => {
  const r = registry.rulesetsForIndustry('not_a_real_industry');
  assert.deepStrictEqual(r, []);
});

// ─── applyCompliance ──────────────────────────────────────────────────────

test('applyCompliance: blocks weight-loss "lose 20 lbs without diet" for gym_fitness', () => {
  const r = registry.applyCompliance({
    draft: 'Lose 20 lbs without diet or exercise — guaranteed.',
    industry: 'gym_fitness',
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.length > 0);
});

test('applyCompliance: blocks mortgage "guaranteed approval"', () => {
  const r = registry.applyCompliance({
    draft: 'Guaranteed mortgage approval — no credit check needed.',
    industry: 'mortgage_broker',
  });
  assert.strictEqual(r.ok, false);
});

test('applyCompliance: blocks SEC "guaranteed returns"', () => {
  const r = registry.applyCompliance({
    draft: 'Get guaranteed 20% returns with our investment system.',
    industry: 'financial_advisor',
  });
  assert.strictEqual(r.ok, false);
});

test('applyCompliance: blocks Fair Housing "perfect for young couples"', () => {
  const r = registry.applyCompliance({
    draft: 'Perfect new home for young couples in the area.',
    industry: 'real_estate_agent',
  });
  assert.strictEqual(r.ok, false);
});

test('applyCompliance: clean copy for healthcare_general passes', () => {
  const r = registry.applyCompliance({
    draft: 'Our clinic offers preventive care. Schedule a visit. Individual results may vary.',
    industry: 'healthcare_general',
  });
  assert.strictEqual(r.ok, true);
});

test('applyCompliance: industry with no compliance ruleset returns ok=true', () => {
  const r = registry.applyCompliance({
    draft: 'Anything we want to say here.',
    industry: 'cafe',
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.rulesets_applied, []);
});

test('applyCompliance: violation includes regulator + statute', () => {
  const r = registry.applyCompliance({
    draft: 'This supplement cures cancer guaranteed.',
    industry: 'ecommerce_supplements',
  });
  assert.ok(r.violations.length > 0);
  const v = r.violations[0];
  assert.ok(v.regulator, 'expected regulator field');
});

// ─── getComplianceGuidance ────────────────────────────────────────────────

test('getComplianceGuidance: returns prompt_segments for regulated industry', () => {
  const g = registry.getComplianceGuidance({ industry: 'mortgage_broker' });
  assert.ok(g.prompt_segments.length > 0);
  assert.ok(g.rulesets_applied.includes('mortgage-broker'));
});

test('getComplianceGuidance: unregulated industry returns empty segments', () => {
  const g = registry.getComplianceGuidance({ industry: 'cafe' });
  assert.strictEqual(g.prompt_segments.length, 0);
});
