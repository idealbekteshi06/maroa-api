'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requireAgency, UPGRADE_URL } = require('../services/higgsfield/agencyGate');
const createHiggsfield = require('../services/higgsfield');
const createWf10 = require('../services/wf10');

// ─── Plan gate ───────────────────────────────────────────────────────────────

test('requireAgency blocks non-agency plans', () => {
  for (const plan of ['starter', 'growth', 'free', '']) {
    const g = requireAgency(plan);
    assert.strictEqual(g.skipped, true);
    assert.strictEqual(g.reason, 'agency_plan_required');
    assert.strictEqual(g.upgrade_url, UPGRADE_URL);
  }
});

test('requireAgency allows agency', () => {
  const g = requireAgency('agency');
  assert.strictEqual(g.skipped, false);
  assert.strictEqual(g.isAgency, true);
});

// ─── Higgsfield premium methods ──────────────────────────────────────────────

function makeHiggsfield(overrides = {}) {
  return createHiggsfield({
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    callClaude: async () =>
      JSON.stringify({
        shot_list: [{ shot: 1, description: 'Hook: product in hand', duration_sec: 2 }],
        camera_moves: ['slow push in'],
        pacing: 'fast',
        suggested_model: 'kling-3.0',
      }),
    extractJSON: (raw) => {
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ANTHROPIC_KEY: 'test-key',
    ...overrides,
  });
}

test('generateVideoVariants returns skipped for non-agency', async () => {
  const svc = makeHiggsfield();
  const out = await svc.generateVideoVariants({ video_prompt: { motion_prompt: 'test' } }, { plan: 'growth' });
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.reason, 'agency_plan_required');
});

test('generateVideoVariants A/B/C matrix defines 3 jobs', () => {
  const { VIDEO_AB_VARIANTS } = require('../services/higgsfield/videoAbVariants');
  assert.strictEqual(VIDEO_AB_VARIANTS.length, 3);
  assert.strictEqual(VIDEO_AB_VARIANTS[0].model, 'nano-banana-pro');
  assert.strictEqual(VIDEO_AB_VARIANTS[0].preset, 'social');
  assert.strictEqual(VIDEO_AB_VARIANTS[1].model, 'kling-3.0');
  assert.strictEqual(VIDEO_AB_VARIANTS[1].preset, 'cinematic');
  assert.strictEqual(VIDEO_AB_VARIANTS[2].model, 'wan-2.5');
  assert.strictEqual(VIDEO_AB_VARIANTS[2].preset, 'ugc');
});

test('uploadSoulId and getSoulId blocked for starter', async () => {
  const svc = makeHiggsfield();
  const up = await svc.uploadSoulId('biz-1', 'https://example.com/face.jpg', { plan: 'starter' });
  assert.strictEqual(up.skipped, true);
  const got = await svc.getSoulId('biz-1', { plan: 'growth' });
  assert.strictEqual(got.skipped, true);
});

test('getSoulId retrieval for agency', async () => {
  const soulRow = {
    business_id: 'biz-1',
    higgsfield_soul_id: 'soul_hf_abc',
    character_name: 'Founder',
    status: 'active',
  };
  const svc = makeHiggsfield({
    sbGet: async (table) => (table === 'soul_ids' ? [soulRow] : []),
  });
  const got = await svc.getSoulId('biz-1', { plan: 'agency' });
  assert.strictEqual(got.higgsfield_soul_id, 'soul_hf_abc');
  assert.strictEqual(got.status, 'active');
});

test('generateShotList returns shot list for agency', async () => {
  const svc = makeHiggsfield();
  const out = await svc.generateShotList('Cafe owner welcomes morning regulars', {
    plan: 'agency',
    businessId: '11111111-1111-1111-1111-111111111111',
  });
  assert.ok(Array.isArray(out.shot_list));
  assert.ok(out.shot_list.length >= 1);
  assert.ok(out.pacing);
  assert.ok(out.suggested_model);
});

test('generateShotList blocked for non-agency', async () => {
  const svc = makeHiggsfield();
  const out = await svc.generateShotList('Scene', { plan: 'starter' });
  assert.strictEqual(out.skipped, true);
});

test('Mr. Higgs cost estimate is defined', () => {
  const { estimateMrHiggsCost } = require('../services/higgsfield/costTracking');
  const est = estimateMrHiggsCost();
  assert.strictEqual(est.credits, 3);
  assert.strictEqual(est.cost_usd, 0.03);
});

// ─── WF10 wiring ─────────────────────────────────────────────────────────────

test('wf10 getBusinessPlan reads businesses row', async () => {
  const wf10 = createWf10({
    sbGet: async (table) => (table === 'businesses' ? [{ plan: 'agency' }] : []),
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    higgsfieldAI: {},
    logger: { warn: () => {} },
  });
  assert.strictEqual(await wf10.getBusinessPlan('biz'), 'agency');
});

test('wf10 recordAbTestResult patches video_ab_tests', async () => {
  const patches = [];
  const wf10 = createWf10({
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async (table, q, body) => {
      patches.push({ table, q, body });
    },
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    higgsfieldAI: {},
    logger: { warn: () => {} },
  });
  await wf10.recordAbTestResult({
    businessId: 'biz',
    abTestId: 'ab-1',
    winnerVariant: 'b',
    metaExperimentId: 'meta_exp_99',
  });
  assert.strictEqual(patches[0].table, 'video_ab_tests');
  assert.strictEqual(patches[0].body.winner_variant, 'b');
  assert.strictEqual(patches[0].body.meta_experiment_id, 'meta_exp_99');
});
