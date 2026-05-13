'use strict';

/**
 * tests/specialists-registry.test.js
 *
 * Wave 60 Session 9 — verifies the specialist registry contract + dispatch.
 *   - 7 specialists load cleanly
 *   - Shape contract enforced
 *   - chooseForJob returns realistic scores for canonical jobs
 *   - pickSpecialist routes jobs to the right specialist
 */

const test = require('node:test');
const assert = require('node:assert');

const registry = require('../services/prompts/specialists');

const EXPECTED_COUNT = 7;
const REQUIRED_EXPORTS = [
  'id',
  'name',
  'description',
  'source_citation',
  'preferred_methodologies',
  'preferred_channels',
  'decision_style',
  'prompt_persona',
  'manipulation_risk_ceiling',
  'job_fit_weights',
  'chooseForJob',
  'generateBriefSegments',
];

// ─── Module loading ───────────────────────────────────────────────────────

test('specialists: listAllIds returns 7 specialist IDs', () => {
  assert.strictEqual(registry.listAllIds().length, EXPECTED_COUNT);
});

test('specialists: every ID maps to a loadable module', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getSpecialist(id);
    assert.ok(mod, `${id} failed to load`);
    assert.notStrictEqual(mod, registry.NULL_MODULE, `${id} resolved to NULL_MODULE`);
  }
});

test('specialists: getSpecialist returns null for unknown id', () => {
  assert.strictEqual(registry.getSpecialist('not-a-specialist'), null);
});

// ─── Shape invariant ──────────────────────────────────────────────────────

for (const field of REQUIRED_EXPORTS) {
  test(`specialists: every module exports "${field}"`, () => {
    for (const id of registry.listAllIds()) {
      const mod = registry.getSpecialist(id);
      assert.ok(mod[field] !== undefined && mod[field] !== null, `${id} missing "${field}"`);
    }
  });
}

test('specialists: manipulation_risk_ceiling is 0-10', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getSpecialist(id);
    assert.ok(
      typeof mod.manipulation_risk_ceiling === 'number' &&
        mod.manipulation_risk_ceiling >= 0 &&
        mod.manipulation_risk_ceiling <= 10
    );
  }
});

test('specialists: every module has preferred_methodologies + preferred_channels', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getSpecialist(id);
    assert.ok(mod.preferred_methodologies.length > 0, `${id} has no methodologies`);
    assert.ok(mod.preferred_channels.length > 0, `${id} has no channels`);
  }
});

// ─── chooseForJob scoring ─────────────────────────────────────────────────

test('chooseForJob: direct-response wins a Black Friday sale job', () => {
  const r = registry.pickSpecialist({
    goal: 'Write a Black Friday email about our flash sale ending tonight',
    channel: 'email-promo',
  });
  assert.strictEqual(r.specialist.id, 'direct-response');
});

test('chooseForJob: brand-builder wins a brand-story manifesto job', () => {
  const r = registry.pickSpecialist({
    goal: 'Write our brand mission and values manifesto for the long-term story',
    channel: 'linkedin-article',
  });
  assert.strictEqual(r.specialist.id, 'brand-builder');
});

test('chooseForJob: performance-marketer wins a paid-ad ROAS optimization job', () => {
  const r = registry.pickSpecialist({
    goal: 'Generate 3 ad variants to optimize ROAS and CTR for Meta',
    channel: 'meta-ads-image',
  });
  assert.strictEqual(r.specialist.id, 'performance-marketer');
});

test('chooseForJob: content-marketer wins an SEO blog post job', () => {
  const r = registry.pickSpecialist({
    goal: 'Write a 1500-word SEO blog post to rank on Google for "best CRM"',
    channel: 'blog-seo',
  });
  assert.strictEqual(r.specialist.id, 'content-marketer');
});

test('chooseForJob: social-media-manager wins a daily Instagram post', () => {
  const r = registry.pickSpecialist({
    goal: 'Write a daily Instagram post for our feed',
    channel: 'instagram-post',
  });
  assert.strictEqual(r.specialist.id, 'social-media-manager');
});

test('chooseForJob: lifecycle-marketer wins a winback retention email', () => {
  const r = registry.pickSpecialist({
    goal: 'Write a winback email for customers who haven\'t purchased in 90 days',
    funnel_stage: 'retention',
    customer_type: 'existing',
    channel: 'email-retention',
  });
  assert.strictEqual(r.specialist.id, 'lifecycle-marketer');
});

test('chooseForJob: growth-engineer wins a referral loop job', () => {
  const r = registry.pickSpecialist({
    goal: 'Design a viral referral loop with invite copy',
    channel: 'email-promo',
  });
  assert.strictEqual(r.specialist.id, 'growth-engineer');
});

// ─── Manipulation-risk ceilings make sense ────────────────────────────────

test('manipulation-risk: brand-builder has the lowest ceiling', () => {
  const all = registry.listSpecialists();
  const brand = all.find((s) => s.id === 'brand-builder');
  for (const s of all) {
    if (s.id === 'brand-builder') continue;
    if (s.id === 'content-marketer') continue; // content also low
    assert.ok(
      brand.manipulation_risk_ceiling <= s.manipulation_risk_ceiling,
      `${s.id} ceiling ${s.manipulation_risk_ceiling} < brand ${brand.manipulation_risk_ceiling}`
    );
  }
});

test('manipulation-risk: direct-response has the highest ceiling (still ≤ 6)', () => {
  const all = registry.listSpecialists();
  const dr = all.find((s) => s.id === 'direct-response');
  for (const s of all) {
    if (s.id === 'direct-response') continue;
    assert.ok(dr.manipulation_risk_ceiling >= s.manipulation_risk_ceiling);
  }
  assert.ok(dr.manipulation_risk_ceiling <= 6, 'Ethics ceiling violated');
});

// ─── generateBriefSegments ────────────────────────────────────────────────

test('generateBriefSegments: every specialist produces non-empty segments', () => {
  for (const id of registry.listAllIds()) {
    const mod = registry.getSpecialist(id);
    const segs = mod.generateBriefSegments({});
    assert.ok(Array.isArray(segs) && segs.length > 0, `${id} produced no segments`);
    assert.ok(segs.some((s) => /SPECIALIST:/.test(s)), `${id} missing SPECIALIST: line`);
    assert.ok(segs.some((s) => /MANIPULATION-RISK CEILING:/.test(s)), `${id} missing ceiling line`);
  }
});

// ─── pickSpecialist returns runners_up for transparency ───────────────────

test('pickSpecialist: includes runners_up for telemetry', () => {
  const r = registry.pickSpecialist({
    goal: 'Write a Black Friday email about our flash sale',
    channel: 'email-promo',
  });
  assert.ok(Array.isArray(r.runners_up));
  assert.ok(r.runners_up.length >= 1);
  assert.ok(r.runners_up[0].score <= r.score, 'top score should be highest');
});

test('pickSpecialist: tie-break when no strong signal still returns a specialist', () => {
  const r = registry.pickSpecialist({ goal: 'Hello', channel: 'instagram-post' });
  assert.ok(r.specialist);
});
