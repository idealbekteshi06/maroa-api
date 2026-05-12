'use strict';

/**
 * tests/creative-engine-critic-integration.test.js
 *
 * Verifies the integration point between services/creative-engine and
 * lib/adversarialCritic. We don't re-test the lib's internals (see
 * tests/adversarial-critic.test.js for that 28-test gauntlet); we test
 * that the engine wires the Critic in for the right plans and bypasses
 * it for the wrong ones.
 */

const test = require('node:test');
const assert = require('node:assert');

const engine = require('../services/creative-engine');

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeSbGet() {
  return async (table) => {
    if (table === 'businesses') {
      return [{ id: 'biz1', plan: 'growth', business_name: 'Test Cafe', industry: 'cafe', daily_budget: 30 }];
    }
    return [];
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

function fakeCallClaude(variantBody = 'Buy our amazing cafe products today') {
  // Returns the {content: [{text: '{"format":...}'}]} shape for variant gen
  // and is replaced when adversarialCritic is stubbed out.
  return async (_args) => ({
    content: [
      {
        text: JSON.stringify({
          format: 'image',
          headline: 'Best Coffee',
          body: variantBody,
          cta: 'Order Now',
          creative_brief: 'cozy cafe interior',
        }),
      },
    ],
  });
}

// Stub adversarialCritic so we can observe what the engine asks of it
function stubCritic({ improved = true, finalBody = 'Trusted by 12,847 cafés in Tirana — try our daily blend' } = {}) {
  const calls = [];
  return {
    calls,
    reflexion: async (opts) => {
      calls.push(opts);
      return {
        final: improved ? finalBody : opts.draft,
        improved,
        rounds: [{ round: 0, severity: 'minor', issueCount: 1 }],
        criticVerdict: { severity: 'minor', issues: [], overall: 'tightened' },
        totalLatencyMs: 12,
      };
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('creative-engine + critic: growth plan triggers body critique only', async () => {
  const stub = stubCritic();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost: fakeSbPost(),
    callClaude: fakeCallClaude(),
    higgsfield: null,
    adversarialCritic: stub,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {}, info: () => {} },
  };
  const out = await engine.generateDailyVariants({ businessId: 'biz1', deps });
  assert.strictEqual(out.ok, true);
  // Growth = 3 variants/day, each runs body critic only (no headline)
  assert.strictEqual(stub.calls.length, 3, 'critic must run 3× for growth plan (body only, 3 variants)');
  for (const c of stub.calls) {
    assert.strictEqual(c.role, 'ad_copy');
    assert.strictEqual(c.skill, 'creative_engine_body_critic');
    assert.strictEqual(c.businessId, 'biz1');
    assert.match(c.criticModel, /haiku/);
  }
});

test('creative-engine + critic: agency plan triggers body + headline critique', async () => {
  const stub = stubCritic();
  const sbGet = async (table) => {
    if (table === 'businesses') {
      return [{ id: 'biz2', plan: 'agency', business_name: 'X', industry: 'cafe', daily_budget: 80 }];
    }
    return [];
  };
  const deps = {
    sbGet,
    sbPost: fakeSbPost(),
    callClaude: fakeCallClaude(),
    higgsfield: null,
    adversarialCritic: stub,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  await engine.generateDailyVariants({ businessId: 'biz2', deps });
  // Agency = 5 variants × (body + headline) = 10 critic calls
  assert.strictEqual(stub.calls.length, 10, 'agency must run body + headline critic on all 5 variants');
  const skills = stub.calls.map((c) => c.skill);
  assert.strictEqual(skills.filter((s) => s === 'creative_engine_body_critic').length, 5);
  assert.strictEqual(skills.filter((s) => s === 'creative_engine_headline_critic').length, 5);
});

test('creative-engine + critic: free plan does not trigger critique', async () => {
  const stub = stubCritic();
  const sbGet = async (table) => {
    if (table === 'businesses') {
      return [{ id: 'biz3', plan: 'free', business_name: 'X', industry: 'cafe', daily_budget: 5 }];
    }
    return [];
  };
  const deps = {
    sbGet,
    sbPost: fakeSbPost(),
    callClaude: fakeCallClaude(),
    higgsfield: null,
    adversarialCritic: stub,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  const out = await engine.generateDailyVariants({ businessId: 'biz3', deps });
  assert.strictEqual(out.generated, 0, 'free plan generates zero variants');
  assert.strictEqual(stub.calls.length, 0, 'critic must not be invoked on free plan');
});

test('creative-engine + critic: rewritten body is persisted (capped at 125 chars)', async () => {
  const stub = stubCritic({
    improved: true,
    finalBody: 'A'.repeat(200), // 200 chars — must be truncated to 125
  });
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude: fakeCallClaude(),
    higgsfield: null,
    adversarialCritic: stub,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  await engine.generateDailyVariants({ businessId: 'biz1', deps });
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  assert.ok(persisted.length > 0, 'variants should be persisted');
  for (const v of persisted) {
    assert.strictEqual(v.row.body.length, 125, 'rewritten body must be truncated to 125 chars');
  }
});

test('creative-engine + critic: critic throw is caught — original variant ships', async () => {
  const stub = {
    reflexion: async () => {
      throw new Error('Haiku is on fire');
    },
  };
  const sbPost = fakeSbPost();
  const deps = {
    sbGet: fakeSbGet(),
    sbPost,
    callClaude: fakeCallClaude('Original body that should survive'),
    higgsfield: null,
    adversarialCritic: stub,
    brandVoice: { buildAnchor: () => ({}) },
    logger: { warn: () => {} },
  };
  const out = await engine.generateDailyVariants({ businessId: 'biz1', deps });
  assert.strictEqual(out.ok, true);
  const persisted = sbPost._inserted.filter((r) => r.table === 'ad_creative_variants');
  assert.strictEqual(persisted.length, 3, 'variants must still ship even when critic crashes');
  for (const v of persisted) {
    assert.strictEqual(v.row.body, 'Original body that should survive');
  }
});
