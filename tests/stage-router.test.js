'use strict';

/**
 * tests/stage-router.test.js
 *
 * Wave 60 Session 2 — verifies the awareness × funnel router:
 *   - All 20 cells return sensible configs (or refusals where invalid)
 *   - routeContent validates inputs
 *   - Invalid cells refuse with reason
 *   - Channel mismatch produces warning, not refusal
 */

const test = require('node:test');
const assert = require('node:assert');

const { routeContent, AWARENESS_STAGES, FUNNEL_STAGES } = require('../lib/stageRouter');

// ─── Input validation ─────────────────────────────────────────────────────

test('routeContent: rejects invalid awareness', () => {
  const r = routeContent({ awareness: 'bogus', funnel: 'tofu' });
  assert.strictEqual(r.ok, false);
  assert.match(r.refusal, /invalid awareness/);
});

test('routeContent: rejects invalid funnel', () => {
  const r = routeContent({ awareness: 'problem_aware', funnel: 'bogus' });
  assert.strictEqual(r.ok, false);
  assert.match(r.refusal, /invalid funnel/);
});

// ─── Valid cell coverage ─────────────────────────────────────────────────

const VALID_CELLS = [
  ['unaware', 'tofu'],
  ['problem_aware', 'tofu'],
  ['problem_aware', 'mofu'],
  ['problem_aware', 'bofu'],
  ['solution_aware', 'tofu'],
  ['solution_aware', 'mofu'],
  ['solution_aware', 'bofu'],
  ['product_aware', 'tofu'],
  ['product_aware', 'mofu'],
  ['product_aware', 'bofu'],
  ['most_aware', 'bofu'],
  ['most_aware', 'retention'],
];

for (const [awareness, funnel] of VALID_CELLS) {
  test(`routeContent: ${awareness} × ${funnel} returns valid config`, () => {
    const r = routeContent({ awareness, funnel });
    assert.strictEqual(r.ok, true, `${awareness}×${funnel} should be valid`);
    assert.ok(Array.isArray(r.methodologies), 'methodologies array');
    assert.ok(r.methodologies.length >= 2, `${awareness}×${funnel}: expected ≥2 methodologies`);
    assert.ok(['none', 'low-friction', 'medium', 'direct-offer', 'appreciative'].includes(r.cta_style));
    assert.ok(typeof r.max_manip_risk === 'number');
    assert.ok(r.max_manip_risk >= 0 && r.max_manip_risk <= 10);
    assert.ok(Array.isArray(r.channel_priority));
    assert.ok(r.channel_priority.length >= 2);
  });
}

// ─── Invalid cells ────────────────────────────────────────────────────────

const INVALID_CELLS = [
  ['unaware', 'mofu'],
  ['unaware', 'bofu'],
  ['unaware', 'retention'],
  ['problem_aware', 'retention'],
  ['solution_aware', 'retention'],
  ['product_aware', 'retention'],
  ['most_aware', 'tofu'],
  ['most_aware', 'mofu'],
];

for (const [awareness, funnel] of INVALID_CELLS) {
  test(`routeContent: ${awareness} × ${funnel} refuses with reason`, () => {
    const r = routeContent({ awareness, funnel });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.invalid_cell, true);
    assert.ok(r.refusal && r.refusal.length > 0);
  });
}

// ─── Cell-specific sanity checks ─────────────────────────────────────────

test('routeContent: unaware×tofu has NO CTA (correct for pure-curiosity TOFU)', () => {
  const r = routeContent({ awareness: 'unaware', funnel: 'tofu' });
  assert.strictEqual(r.cta_style, 'none');
  assert.strictEqual(r.tone, 'curious');
});

test('routeContent: most_aware×retention uses appreciative tone + low manip ceiling', () => {
  const r = routeContent({ awareness: 'most_aware', funnel: 'retention' });
  assert.strictEqual(r.cta_style, 'appreciative');
  assert.strictEqual(r.tone, 'appreciative');
  assert.ok(r.max_manip_risk <= 5, 'retention must have low manip ceiling');
});

test('routeContent: bofu cells have direct-offer CTA + urgent tone', () => {
  for (const awareness of ['solution_aware', 'product_aware', 'most_aware']) {
    const r = routeContent({ awareness, funnel: 'bofu' });
    assert.strictEqual(r.cta_style, 'direct-offer', `${awareness}×bofu should be direct-offer`);
    assert.strictEqual(r.tone, 'urgent');
  }
});

test('routeContent: all methodology IDs map to real frameworks in the registry', () => {
  const registry = require('../services/prompts/methodologies');
  for (const [awareness, funnel] of VALID_CELLS) {
    const r = routeContent({ awareness, funnel });
    for (const id of r.methodologies) {
      const mod = registry.getFramework(id);
      assert.ok(mod && mod !== registry.NULL_MODULE, `${awareness}×${funnel} references unknown framework "${id}"`);
    }
  }
});

// ─── Channel warnings ────────────────────────────────────────────────────

test('routeContent: channel mismatch produces warning, not refusal', () => {
  // Pick a cell where TikTok is NOT in the priority list (BOFU cells)
  const r = routeContent({ awareness: 'product_aware', funnel: 'bofu', channel: 'tiktok' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.length >= 1);
  assert.match(r.warnings[0], /not in the priority list/);
});

test('routeContent: matching channel produces no warning', () => {
  const r = routeContent({ awareness: 'unaware', funnel: 'tofu', channel: 'tiktok' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 0);
});

// ─── Constants ───────────────────────────────────────────────────────────

test('routeContent: AWARENESS_STAGES + FUNNEL_STAGES are frozen + complete', () => {
  assert.strictEqual(AWARENESS_STAGES.length, 5);
  assert.strictEqual(FUNNEL_STAGES.length, 4);
  for (const s of ['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware']) {
    assert.ok(AWARENESS_STAGES.includes(s));
  }
  for (const s of ['tofu', 'mofu', 'bofu', 'retention']) {
    assert.ok(FUNNEL_STAGES.includes(s));
  }
});

// ─── manipulation_risk ceilings make sense ──────────────────────────────

test('routeContent: retention has lower manip ceiling than bofu', () => {
  const retention = routeContent({ awareness: 'most_aware', funnel: 'retention' });
  const bofu = routeContent({ awareness: 'product_aware', funnel: 'bofu' });
  assert.ok(retention.max_manip_risk < bofu.max_manip_risk);
});

test('routeContent: tofu has lower manip ceiling than bofu (within same awareness)', () => {
  const tofu = routeContent({ awareness: 'problem_aware', funnel: 'tofu' });
  const bofu = routeContent({ awareness: 'product_aware', funnel: 'bofu' });
  assert.ok(tofu.max_manip_risk <= bofu.max_manip_risk);
});
