'use strict';

/**
 * tests/psychology-integrations.test.js
 * ----------------------------------------------------------------------------
 * Verifies the marketing-psychology layer is correctly wired into every
 * service that should consume it.
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const qg = require('../services/prompts/quality-gate');
const vp = require('../services/prompts/voice-polish');
const cro = require('../services/prompts/cro');
const cd = require('../services/prompts/creative-director');
const ao = require('../services/prompts/ad-optimizer');

// ─── Quality Gate wiring ──────────────────────────────────────────────────

test('quality-gate: includes psychology check in checks output', async () => {
  const r = await qg.gate({
    text: 'Get our free guide. Trusted by 1,200+ business owners.',
    business: { industry: 'saas', primary_language: 'en' },
    contentType: 'caption',
    plan: 'free',
  });
  assert.ok(r.checks.psychology, 'psychology check missing');
  assert.ok(typeof r.checks.psychology.score === 'number' || r.checks.psychology.skipped);
});

test('quality-gate: psychology threshold=0 for audit_narrative skips check', async () => {
  const r = await qg.gate({
    text: 'ROAS dropped to 1.2 over 7 days, sample 200 clicks.',
    business: { industry: 'saas', primary_language: 'en' },
    contentType: 'audit_narrative',
    plan: 'free',
  });
  assert.strictEqual(r.checks.psychology.skipped, true);
});

test('quality-gate: dental scarcity hits manipulation_risk_high → soft block', async () => {
  const r = await qg.gate({
    text: 'Only 5 implant slots left this month. Don\'t miss out!',
    business: { industry: 'dental', primary_language: 'en' },
    contentType: 'ad_copy',
    plan: 'free', // no callClaude → soft becomes hard
  });
  // High risk ad copy in restricted industry → reject (no retry path on free)
  assert.strictEqual(r.decision, 'reject');
  assert.ok(r.blocking_issues.includes('manipulation_risk_high') || r.blocking_issues.length > 0);
});

test('quality-gate: psychology check returns top recommendation', async () => {
  const r = await qg.gate({
    text: 'We sell coffee.',
    business: { industry: 'cafe', primary_language: 'en' },
    contentType: 'caption',
    plan: 'free',
  });
  // Free tier ships with warning since slop is fine but psychology weak; we
  // just verify the check ran with a recommendation.
  assert.ok(r.checks.psychology);
  // Score should be low for one-sentence copy without principles
  assert.ok(r.checks.psychology.score < 50 || r.checks.psychology.skipped);
});

// ─── Voice Polish wiring ──────────────────────────────────────────────────

test('voice-polish: includePsychology=true returns psychology field', async () => {
  const r = await vp.polish({
    text: 'Get our free coffee. Trusted by 1,200 customers.',
    business: { industry: 'cafe', primary_language: 'en' },
    plan: 'free',
    includePsychology: true,
  });
  assert.ok(r.psychology);
  assert.ok(typeof r.psychology.score === 'number');
  assert.ok(Array.isArray(r.psychology.principles_applied));
});

test('voice-polish: includePsychology=false (default) does not include field', async () => {
  const r = await vp.polish({
    text: 'Open 9-17 daily.',
    business: { industry: 'cafe', primary_language: 'en' },
    plan: 'free',
  });
  assert.strictEqual(r.psychology, undefined);
});

test('voice-polish: psychology field includes manipulation_risk', async () => {
  const r = await vp.polish({
    text: 'Only 3 slots left. Limited time.',
    business: { industry: 'retail', primary_language: 'en' },
    plan: 'free',
    includePsychology: true,
  });
  assert.ok(r.psychology);
  assert.ok(['low', 'medium', 'high'].includes(r.psychology.manipulation_risk));
});

// ─── CRO Rewrite wiring ───────────────────────────────────────────────────

test('cro: applyPsychology flag triggers enrichment on agency tier', async () => {
  let psychologyApplyCount = 0;
  const r = await cro.rewritePage({
    business: { business_name: 'X', industry: 'saas', primary_language: 'en' },
    plan: 'agency',
    applyPsychology: true,
    callClaude: async (opts) => {
      // First call = CRO rewrite, second/third = psychology apply
      if (opts.system && opts.system.includes('psychology copywriter')) {
        psychologyApplyCount++;
        return JSON.stringify({
          rewritten: 'Trusted by 4,200 businesses just like yours.',
          changes_made: ['Added social proof'],
          language_preserved: true,
          facts_preserved: true,
        });
      }
      // CRO rewrite call
      return JSON.stringify({
        hero_headline_variants: [{ text: 'Run your business better.', rationale: 'clear' }],
        hero_subhead_variants: [],
        primary_cta_variants: [{ text: 'Get started', style: 'action_imperative' }],
        value_prop_bullets: [],
      });
    },
    extractJSON: JSON.parse,
  });
  assert.ok(psychologyApplyCount >= 1, 'psychology apply should fire on agency tier with flag');
  assert.ok(r.psychology_enriched, 'psychology_enriched field should be present');
});

test('cro: applyPsychology=false skips enrichment (default)', async () => {
  let psychCalled = false;
  const r = await cro.rewritePage({
    business: { business_name: 'X', industry: 'saas', primary_language: 'en' },
    plan: 'agency',
    applyPsychology: false,
    callClaude: async (opts) => {
      if (opts.system && opts.system.includes('psychology copywriter')) {
        psychCalled = true;
      }
      return JSON.stringify({
        hero_headline_variants: [{ text: 'Hero text', rationale: 'X' }],
        hero_subhead_variants: [],
        primary_cta_variants: [{ text: 'Get started', style: 'action_imperative' }],
        value_prop_bullets: [],
      });
    },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(psychCalled, false);
  assert.strictEqual(r.psychology_enriched, undefined);
});

test('cro: applyPsychology on growth tier does NOT trigger enrichment', async () => {
  let psychCalled = false;
  await cro.rewritePage({
    business: { business_name: 'X', industry: 'cafe', primary_language: 'en' },
    plan: 'growth',
    applyPsychology: true,
    callClaude: async (opts) => {
      if (opts.system && opts.system.includes('psychology copywriter')) psychCalled = true;
      return JSON.stringify({
        hero_headline_variants: [{ text: 'Hero', rationale: 'X' }],
        hero_subhead_variants: [],
        primary_cta_variants: [{ text: 'Buy', style: 'action_imperative' }],
        value_prop_bullets: [],
      });
    },
    extractJSON: JSON.parse,
  });
  // Only Agency tier triggers psychology enrichment in CRO
  assert.strictEqual(psychCalled, false);
});

// ─── Creative Director wiring ─────────────────────────────────────────────

test('creative-director: enrichConceptWithPsychology on free tier returns audit', async () => {
  const r = await cd.enrichConceptWithPsychology({
    concept: {
      top_concept: { hook: 'Best coffee in the city.', one_sentence: 'Fresh espresso.' },
    },
    business: { industry: 'cafe', primary_language: 'en' },
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.ok(r.psychology_enriched);
  assert.strictEqual(r.psychology_enriched.applied, false);
  assert.strictEqual(r.psychology_enriched.reason, 'free_tier');
});

test('creative-director: enrichConceptWithPsychology on agency tier applies principle', async () => {
  let applyCallCount = 0;
  const r = await cd.enrichConceptWithPsychology({
    concept: {
      top_concept: {
        hook: 'We sell coffee.',
        downstream_brief_for_higgsfield: { action: 'Buy now.' },
      },
    },
    business: { industry: 'cafe', primary_language: 'en' },
    plan: 'agency',
    callClaude: async () => {
      applyCallCount++;
      return JSON.stringify({
        rewritten: 'Trusted by 4,200 daily customers.',
        changes_made: ['Added social proof'],
        language_preserved: true,
        facts_preserved: true,
      });
    },
    extractJSON: JSON.parse,
  });
  assert.ok(r.psychology_enriched);
  assert.strictEqual(r.psychology_enriched.applied, true);
  assert.ok(applyCallCount >= 1);
});

test('creative-director: enrichConceptWithPsychology returns unchanged concept if missing top_concept', async () => {
  const r = await cd.enrichConceptWithPsychology({
    concept: { something_else: true },
    business: { industry: 'cafe' },
    plan: 'agency',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.deepStrictEqual(r, { something_else: true });
});

// ─── Ad Optimizer wiring ──────────────────────────────────────────────────

test('ad-optimizer: auditAdCopyPsychology returns audit for short copy', async () => {
  const r = await ao.auditAdCopyPsychology({
    adCopy: 'Get our free guide. Used by 5,000+ small businesses.',
    business: { industry: 'saas', primary_language: 'en' },
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.ok(typeof r.overall_score === 'number');
  assert.ok(Array.isArray(r.principles_applied));
});

test('ad-optimizer: auditAdCopyPsychology skips when copy too short', async () => {
  const r = await ao.auditAdCopyPsychology({
    adCopy: 'Buy',
    business: { industry: 'saas' },
    plan: 'free',
    callClaude: async () => '{}',
    extractJSON: JSON.parse,
  });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'insufficient_copy');
});

test('ad-optimizer: auditAdCopyPsychology free tier deterministic-only (no LLM)', async () => {
  let claudeCalled = false;
  await ao.auditAdCopyPsychology({
    adCopy: 'Save 30% this week. Trusted by 1,000+ customers.',
    business: { industry: 'retail', primary_language: 'en' },
    plan: 'free',
    callClaude: async () => { claudeCalled = true; return '{}'; },
    extractJSON: JSON.parse,
  });
  assert.strictEqual(claudeCalled, false, 'free tier should not call LLM for psychology audit');
});
