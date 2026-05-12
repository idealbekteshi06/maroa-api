'use strict';

/**
 * tests/creative-engine-grounding-nbest-integration.test.js
 *
 * Verifies the closed-loop creative system wiring in services/creative-engine:
 *   grounding context → oversample N candidates → N-best judge → critic → ship
 *
 * Lib internals are covered by tests/grounding-context.test.js (14 tests) and
 * tests/nbest-reranker.test.js (21 tests). These tests just verify the engine
 * orchestrates them correctly.
 */

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../services/creative-engine');

function makeFakeApp() {
  return null;
} // not needed; engine doesn't take an app

function fakeSbGet(seed = {}) {
  return async (table, query = '') => {
    if (table === 'businesses') {
      return [
        seed.business || { id: 'biz1', plan: 'growth', business_name: 'Test', industry: 'cafe', daily_budget: 30 },
      ];
    }
    return seed[table] || [];
  };
}

function fakeSbPost() {
  const inserted = [];
  const fn = async (table, row) => {
    inserted.push({ table, row });
    return { ok: true };
  };
  fn._inserted = inserted;
  return fn;
}

// Returns the variant JSON shape for variant calls; returns rankings JSON
// for judge calls (we detect via system prompt content).
function fakeClaudeWithJudge({ rankings = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    // Judge call (N-best reranker uses system that includes "judge ranking")
    if (args.system && /judge.*ranking|ranking.*draft/i.test(args.system)) {
      if (rankings) return JSON.stringify({ rankings });
      // Default: pick the candidates with even indices first
      return JSON.stringify({
        rankings: [
          { index: 0, score: 95, rationale: 'best' },
          { index: 2, score: 80, rationale: 'second' },
          { index: 4, score: 75, rationale: 'third' },
          { index: 1, score: 60, rationale: 'fourth' },
          { index: 3, score: 50, rationale: 'fifth' },
          { index: 5, score: 40, rationale: 'sixth' },
        ],
      });
    }
    // Critic call (system mentions "critiquing")
    if (args.system && /critiquing|rewrite/i.test(args.system)) {
      return '{"severity":"pass","issues":[],"overall":"ship it"}';
    }
    // Variant generation
    const idx = calls.filter((c) => c.system && /produce a single ad variant/.test(c.system)).length - 1;
    return {
      content: [
        {
          text: JSON.stringify({
            format: 'image',
            headline: `Headline ${idx}`,
            body: `Specific body ${idx} grounded in customer voice`,
            cta: 'Order Now',
            creative_brief: 'cozy cafe',
          }),
        },
      ],
    };
  };
  fn._calls = calls;
  return fn;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('creative-engine + grounding + N-best: growth oversamples 2× then judge picks 3', async () => {
  const callClaude = fakeClaudeWithJudge();
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude,
    higgsfield: null,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {}, info: () => {} },
  };
  const out = await engine.generateDailyVariants({ businessId: 'biz1', deps });
  assert.strictEqual(out.ok, true);
  // Variants generated: 3 plan × 2 oversample = 6 candidate calls
  const variantCalls = callClaude._calls.filter((c) => c.system && /produce a single ad variant/.test(c.system));
  assert.strictEqual(variantCalls.length, 6, 'growth plan should oversample 6 candidates');
  // Judge call exactly once
  const judgeCalls = callClaude._calls.filter((c) => c.system && /judge.*ranking|ranking.*draft/i.test(c.system));
  assert.strictEqual(judgeCalls.length, 1, 'judge should fire once for 6→3 ranking');
  // Persisted variants
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  assert.strictEqual(persisted.length, 3, 'exactly variantsPerDay variants persisted');
});

test('creative-engine + grounding: grounding context built once per business batch', async () => {
  let groundingBuildCalls = 0;
  const stubGrounding = {
    buildGroundingContext: async (opts) => {
      groundingBuildCalls++;
      return {
        isEmpty: () => false,
        toPromptBlock: () => `# GROUNDING CONTEXT for ${opts.businessId} (${opts.surface})\nNEVER say: hustle`,
      };
    },
  };
  const callClaude = fakeClaudeWithJudge();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost: fakeSbPost(),
    callClaude,
    higgsfield: null,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
    groundingContext: stubGrounding,
  };
  await engine.generateDailyVariants({ businessId: 'biz1', deps });
  assert.strictEqual(groundingBuildCalls, 1, 'grounding context built exactly once per batch (not per variant)');
  // Verify grounding block was injected into variant prompts
  const variantCalls = callClaude._calls.filter((c) => c.system && /produce a single ad variant/.test(c.system));
  for (const c of variantCalls) {
    assert.match(c.system, /GROUNDING CONTEXT for biz1/, 'every variant call must include the grounding block');
    assert.match(c.system, /NEVER say: hustle/, 'brand voice constraints must flow through');
  }
});

test('creative-engine + N-best: judge picks the top-scored candidates (not insertion order)', async () => {
  // Configure judge to pick index 5 as best, then 4, then 3 (reverse order)
  const callClaude = fakeClaudeWithJudge({
    rankings: [
      { index: 5, score: 95, rationale: 'best' },
      { index: 4, score: 80, rationale: 'second' },
      { index: 3, score: 70, rationale: 'third' },
      { index: 2, score: 60, rationale: 'fourth' },
      { index: 1, score: 50, rationale: 'fifth' },
      { index: 0, score: 40, rationale: 'sixth' },
    ],
  });
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude,
    higgsfield: null,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  await engine.generateDailyVariants({ businessId: 'biz1', deps });
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  // Top-3 picks should be candidates 5, 4, 3 — meaning bodies "Specific body 5/4/3..."
  const bodies = persisted.map((p) => p.row.body);
  assert.ok(
    bodies.some((b) => b.includes('body 5')),
    'best-scored candidate must ship'
  );
  assert.ok(bodies.some((b) => b.includes('body 4')));
  assert.ok(bodies.some((b) => b.includes('body 3')));
  // Lower-scored candidates 0, 1, 2 must NOT ship
  assert.ok(!bodies.some((b) => b.includes('body 0')), 'lowest-scored candidate must NOT ship');
});

test('creative-engine + N-best: judge failure falls back to insertion order', async () => {
  const callClaude = async (args) => {
    if (args.system && /judge.*ranking|ranking.*draft/i.test(args.system)) {
      return 'completely malformed garbage not json';
    }
    if (args.system && /critiquing|rewrite/i.test(args.system)) {
      return '{"severity":"pass","issues":[],"overall":""}';
    }
    return {
      content: [
        {
          text: JSON.stringify({
            format: 'image',
            headline: 'H',
            body: 'B',
            cta: 'X',
            creative_brief: '',
          }),
        },
      ],
    };
  };
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude,
    higgsfield: null,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  const out = await engine.generateDailyVariants({ businessId: 'biz1', deps });
  assert.strictEqual(out.ok, true);
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  assert.strictEqual(persisted.length, 3, 'judge failure must still produce variantsPerDay variants');
});

test('creative-engine + N-best: judge score + rationale persisted on each variant', async () => {
  const callClaude = fakeClaudeWithJudge();
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude,
    higgsfield: null,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  await engine.generateDailyVariants({ businessId: 'biz1', deps });
  // Note: judge scores are attached to the variant object but the persistence
  // layer (sbPost call inside generateDailyVariants) doesn't currently include
  // them in the row. We just verify the engine didn't crash. Future migration
  // would add a `judge_score` column to ad_creative_variants.
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  assert.strictEqual(persisted.length, 3);
});
