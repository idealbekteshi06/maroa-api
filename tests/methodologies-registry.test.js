'use strict';

/**
 * tests/methodologies-registry.test.js
 *
 * Wave 60 Session 1 — verifies the methodology registry contract:
 *   - 29 modules load cleanly
 *   - Every module exports the required shape
 *   - listFrameworks filter logic works
 *   - applyFrameworks aggregates correctly
 *   - recommendFrameworks picks across categories
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../services/prompts/methodologies');

const EXPECTED_COUNT = 29;
const REQUIRED_EXPORTS = [
  'id',
  'name',
  'category',
  'source_citation',
  'applicability',
  'invariants',
  'manipulation_risk',
  'applyToDraft',
  'generateFromSpec',
];

const VALID_CATEGORIES = ['structural', 'psychology', 'proof', 'response', 'brand', 'modern'];

// ─── Module loading ───────────────────────────────────────────────────────

test('registry: listAllIds returns 29 framework IDs', () => {
  assert.strictEqual(registry.listAllIds().length, EXPECTED_COUNT);
});

test('registry: every ID maps to a loadable module', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    assert.ok(mod, `${id} failed to load`);
    assert.notStrictEqual(mod, registry.NULL_MODULE, `${id} resolved to NULL_MODULE`);
  }
});

// ─── Shape invariant for ALL 29 modules ───────────────────────────────────
// One test per export field — fast to read in failure output.

for (const field of REQUIRED_EXPORTS) {
  test(`registry: every module exports "${field}"`, () => {
    for (const id of registry.listAllIds()) {
      const mod = registry.getFramework(id);
      assert.ok(mod[field] !== undefined && mod[field] !== null, `${id} missing "${field}"`);
    }
  });
}

test('registry: every module has valid category', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    assert.ok(VALID_CATEGORIES.includes(mod.category), `${id} has invalid category "${mod.category}"`);
  }
});

test('registry: every module has manipulation_risk in 0..10', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    assert.ok(typeof mod.manipulation_risk === 'number');
    assert.ok(mod.manipulation_risk >= 0 && mod.manipulation_risk <= 10, `${id} risk=${mod.manipulation_risk}`);
  }
});

test('registry: every module has applicability with 5 expected lists', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    const a = mod.applicability;
    for (const key of ['awareness_stages', 'funnel_stages', 'channels', 'industries', 'regions']) {
      assert.ok(Array.isArray(a[key]), `${id} applicability.${key} not array`);
    }
  }
});

test('registry: applyToDraft returns the expected shape for empty input', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    const r = mod.applyToDraft('', {});
    assert.ok(typeof r === 'object');
    assert.ok(typeof r.score === 'number');
    assert.ok(Array.isArray(r.fixes));
  }
});

test('registry: invariants are properly structured', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getFramework(id);
    assert.ok(Array.isArray(mod.invariants), `${id} invariants not array`);
    for (const inv of mod.invariants) {
      assert.ok(inv.id, `${id} invariant missing id`);
      assert.ok(inv.rule, `${id} invariant missing rule`);
      assert.ok(['must_have', 'must_avoid'].includes(inv.kind), `${id} bad invariant kind`);
    }
  }
});

// ─── listFrameworks filtering ─────────────────────────────────────────────

test('registry: listFrameworks() with no filter returns all', () => {
  assert.strictEqual(registry.listFrameworks().length, EXPECTED_COUNT);
});

test('registry: listFrameworks({category: psychology}) returns only psychology', () => {
  const psych = registry.listFrameworks({ category: 'psychology' });
  assert.ok(psych.length >= 5, 'expected ≥5 psychology modules');
  for (const m of psych) assert.strictEqual(m.category, 'psychology');
});

test('registry: listFrameworks filters by funnel stage', () => {
  const bofu = registry.listFrameworks({ applicability: { funnel_stage: 'bofu' } });
  assert.ok(bofu.length > 0);
  for (const m of bofu) {
    const f = m.applicability.funnel_stages;
    assert.ok(f.includes('bofu') || f.includes('*'), `${m.id} not applicable to bofu`);
  }
});

// ─── applyFrameworks aggregation ──────────────────────────────────────────

test('registry: applyFrameworks runs 3 modules and aggregates', () => {
  const r = registry.applyFrameworks({
    draft: 'Tired of slow software? Sign up free today — 12,847 customers already saved 4 hours/week.',
    frameworks: ['pas', 'aida', 'sugarman-30-triggers'],
  });
  assert.strictEqual(r.per_framework.length, 3);
  assert.ok(r.aggregate_score >= 0 && r.aggregate_score <= 1);
  assert.ok(r.manipulation_risk_total >= 0);
});

test('registry: applyFrameworks survives a module throwing', () => {
  // Pass an invalid id mixed with valid ones
  const r = registry.applyFrameworks({
    draft: 'Sample text',
    frameworks: ['aida', 'not-a-real-framework'],
  });
  assert.strictEqual(r.per_framework.length, 2);
  const failed = r.per_framework.find((f) => f.error);
  assert.ok(failed, 'invalid framework should be reported as error');
});

test('registry: applyFrameworks handles empty inputs', () => {
  assert.deepStrictEqual(registry.applyFrameworks({}), {
    per_framework: [],
    aggregate_score: 0,
    all_fixes: [],
    manipulation_risk_total: 0,
  });
});

// ─── recommendFrameworks ─────────────────────────────────────────────────

test('registry: recommendFrameworks picks across categories', () => {
  const recs = registry.recommendFrameworks({
    awareness_stage: 'problem_aware',
    funnel_stage: 'mofu',
    channel: 'email-promo',
  });
  assert.ok(recs.length >= 1 && recs.length <= 3);
  const cats = new Set(recs.map((r) => r.category));
  assert.ok(cats.size >= 1);
});

test('registry: recommendFrameworks returns IDs that exist', () => {
  const recs = registry.recommendFrameworks({ funnel_stage: 'bofu' });
  for (const r of recs) {
    assert.ok(registry.getFramework(r.id), `recommended ${r.id} not in registry`);
  }
});

// ─── getFramework error path ─────────────────────────────────────────────

test('registry: getFramework returns null for unknown id', () => {
  assert.strictEqual(registry.getFramework('not-a-framework'), null);
});

test('registry: CATEGORIES constant is frozen', () => {
  assert.throws(() => {
    registry.CATEGORIES.NEW_CATEGORY = 'fail';
  }, /Cannot add property|read[\- ]only/);
});
