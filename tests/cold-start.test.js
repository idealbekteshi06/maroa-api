'use strict';

const test = require('node:test');
const assert = require('node:assert');

const phases = require('../services/cold-start/phases');
const orchestrator = require('../services/cold-start/orchestrator');
const launcher = require('../services/ad-optimizer/launcher');

// ─── Phase registry ───────────────────────────────────────────────────────

test('cold-start: PHASES is in expected order', () => {
  assert.deepStrictEqual(phases.PHASES, [
    'classify_industry',
    'detect_competitors',
    'build_brand_voice_anchor',
    'train_soul_id',
    'generate_concepts',
    'await_concept_approval',
    'launch_initial_campaigns',
    'schedule_first_content',
    'ship_ai_seo_baseline',
    'complete',
  ]);
});

test('cold-start: PHASE_PCT is monotonically increasing', () => {
  let prev = -1;
  for (const phase of phases.PHASES) {
    const pct = phases.PHASE_PCT[phase];
    assert.ok(pct >= prev, `phase ${phase} pct ${pct} < prev ${prev}`);
    prev = pct;
  }
  assert.strictEqual(phases.PHASE_PCT.complete, 100);
});

// ─── Orchestrator: nextPhase ──────────────────────────────────────────────

test('orchestrator: nextPhase advances correctly', () => {
  assert.strictEqual(orchestrator.nextPhase('classify_industry'), 'detect_competitors');
  assert.strictEqual(orchestrator.nextPhase('ship_ai_seo_baseline'), 'complete');
  assert.strictEqual(orchestrator.nextPhase('complete'), null);
  assert.strictEqual(orchestrator.nextPhase('unknown_phase'), null);
});

// ─── Phase 1: classify industry uses customer input when present ─────────

test('classifyIndustry: trusts customer-provided industry', async () => {
  const calls = [];
  const deps = {
    sbGet: async () => [{ id: 'biz-1', industry: 'dental clinic', business_name: 'Test' }],
    callClaude: async (...args) => {
      calls.push(args);
      return { content: [{ text: '{}' }] };
    },
    logger: { warn: () => {}, error: () => {} },
  };
  const r = await phases.classifyIndustry({ businessId: 'biz-1', deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.industry, 'dental clinic');
  assert.strictEqual(r.data.source, 'customer_provided');
  assert.strictEqual(calls.length, 0, 'Should NOT call Claude when customer already provided industry');
});

test('classifyIndustry: falls back to Claude when industry empty', async () => {
  const deps = {
    sbGet: async () => [{ id: 'biz-2', industry: null, business_name: 'Acme' }],
    callClaude: async () => ({ content: [{ text: '{"industry":"saas b2b","sub_industry":null,"confidence":0.9}' }] }),
    logger: { warn: () => {}, error: () => {} },
  };
  const r = await phases.classifyIndustry({ businessId: 'biz-2', deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.industry, 'saas b2b');
  assert.strictEqual(r.data.source, 'llm');
});

// ─── Phase 4: train Soul ID gates on photos ──────────────────────────────

// Env var helper — set/restore HIGGSFIELD_BEARER_TOKEN around a test
function withFnfToken(token, fn) {
  return async () => {
    const prev = process.env.HIGGSFIELD_BEARER_TOKEN;
    if (token) process.env.HIGGSFIELD_BEARER_TOKEN = token;
    else delete process.env.HIGGSFIELD_BEARER_TOKEN;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.HIGGSFIELD_BEARER_TOKEN;
      else process.env.HIGGSFIELD_BEARER_TOKEN = prev;
    }
  };
}

test(
  'trainSoulId: Cloud-only account → graceful skip with prompt_driven mode',
  withFnfToken('', async () => {
    // No HIGGSFIELD_BEARER_TOKEN → Cloud-only path. Should skip gracefully
    // and NEVER block onboarding (the A+++ rule).
    let patched = null;
    const deps = {
      sbGet: async () => [], // no photos required for Cloud-only path
      sbPatch: async (table, q, body) => {
        patched = { table, body };
      },
      higgsfield: { trainSoulCharacter: async () => ({}) },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const r = await phases.trainSoulId({ businessId: 'biz-cloud-only', deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(
      r.awaitingInput,
      undefined,
      'Cloud-only path must NOT request more photos — onboarding continues'
    );
    assert.strictEqual(r.data.soul_id, null);
    assert.strictEqual(r.data.used_cloud_only, true);
    assert.strictEqual(r.data.generation_mode, 'prompt_driven');
    assert.ok(/Standard tier|prompt-driven/i.test(r.data.message));
    // Should clear soul_id on businesses row to remove any stale value
    assert.strictEqual(patched?.table, 'businesses');
    assert.strictEqual(patched?.body?.soul_id, null);
  })
);

test(
  'trainSoulId: FNF path + <5 photos → awaitingInput',
  withFnfToken('hf_test_bearer', async () => {
    const deps = {
      sbGet: async () => [
        { id: 'p1', photo_url: 'https://1' },
        { id: 'p2', photo_url: 'https://2' },
        { id: 'p3', photo_url: 'https://3' },
      ],
      sbPatch: async () => {},
      higgsfield: { trainSoulCharacter: async () => ({}) },
      logger: { warn: () => {}, error: () => {} },
    };
    const r = await phases.trainSoulId({ businessId: 'biz-3', deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.awaitingInput, true);
    assert.strictEqual(r.data.uploaded, 3);
    assert.strictEqual(r.data.required, 5);
  })
);

test(
  'trainSoulId: FNF path + 5+ photos → trains, returns character_locked mode',
  withFnfToken('hf_test_bearer', async () => {
    let capturedArgs = null;
    const deps = {
      sbGet: async () => [
        { id: 'p1', photo_url: 'https://1' },
        { id: 'p2', photo_url: 'https://2' },
        { id: 'p3', photo_url: 'https://3' },
        { id: 'p4', photo_url: 'https://4' },
        { id: 'p5', photo_url: 'https://5' },
      ],
      sbPatch: async () => {},
      higgsfield: {
        trainSoulCharacter: async (args) => {
          capturedArgs = args;
          return { higgsfield_character_id: 'soul_abc123', model_used: 'soul_2', api_used: 'fnf' };
        },
      },
      logger: { warn: () => {}, error: () => {} },
    };
    const r = await phases.trainSoulId({ businessId: 'biz-4', deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.awaitingInput, undefined);
    assert.strictEqual(r.data.soul_id, 'soul_abc123');
    assert.strictEqual(r.data.generation_mode, 'character_locked');
    assert.strictEqual(r.data.api_used, 'fnf');
    assert.strictEqual(capturedArgs.model, 'soul_2');
    assert.strictEqual(capturedArgs.sourceImageUrls.length, 5);
  })
);

test(
  'trainSoulId: FNF path + training error → graceful fallback (does NOT kill onboarding)',
  withFnfToken('hf_test_bearer', async () => {
    const deps = {
      sbGet: async () => [
        { id: 'p1', photo_url: 'https://1' },
        { id: 'p2', photo_url: 'https://2' },
        { id: 'p3', photo_url: 'https://3' },
        { id: 'p4', photo_url: 'https://4' },
        { id: 'p5', photo_url: 'https://5' },
      ],
      sbPatch: async () => {},
      higgsfield: {
        trainSoulCharacter: async () => {
          throw new Error('Higgsfield 503');
        },
      },
      logger: { warn: () => {}, error: () => {} },
    };
    const r = await phases.trainSoulId({ businessId: 'biz-fail', deps });
    assert.strictEqual(r.ok, true, 'A+++ rule: training failure must NEVER kill cold-start');
    assert.strictEqual(r.data.soul_id, null);
    assert.strictEqual(r.data.generation_mode, 'prompt_driven_fallback');
    assert.ok(/503/.test(r.data.training_error));
  })
);

test(
  'trainSoulId: FNF path passes up to 10 photos (better identity lock)',
  withFnfToken('hf_test_bearer', async () => {
    let capturedArgs = null;
    const photoRows = [];
    for (let i = 1; i <= 15; i += 1) photoRows.push({ id: `p${i}`, photo_url: `https://${i}` });
    const deps = {
      sbGet: async () => photoRows,
      sbPatch: async () => {},
      higgsfield: {
        trainSoulCharacter: async (args) => {
          capturedArgs = args;
          return { higgsfield_character_id: 'soul_xyz', model_used: 'soul_2', api_used: 'fnf' };
        },
      },
      logger: { warn: () => {}, error: () => {} },
    };
    await phases.trainSoulId({ businessId: 'biz-5', deps });
    assert.strictEqual(capturedArgs.sourceImageUrls.length, 10);
  })
);

// ─── Launcher: platform eligibility ──────────────────────────────────────

test('launcher: TikTok routed out below $20/day', () => {
  assert.deepStrictEqual(launcher.eligiblePlatforms({ dailyBudget: 5 }), ['meta']);
  assert.deepStrictEqual(launcher.eligiblePlatforms({ dailyBudget: 15 }), ['meta']);
});

test('launcher: $20-49/day gets Meta + Google', () => {
  assert.deepStrictEqual(launcher.eligiblePlatforms({ dailyBudget: 30 }), ['meta', 'google']);
});

test('launcher: $50+/day gets all 3 platforms', () => {
  assert.deepStrictEqual(launcher.eligiblePlatforms({ dailyBudget: 50 }), ['meta', 'google', 'tiktok']);
  assert.deepStrictEqual(launcher.eligiblePlatforms({ dailyBudget: 500 }), ['meta', 'google', 'tiktok']);
});

// ─── Launcher: industry → conversion event ───────────────────────────────

test('launcher: conversionEventForIndustry maps key industries', () => {
  assert.strictEqual(launcher.conversionEventForIndustry('dental clinic').meta, 'Schedule');
  assert.strictEqual(launcher.conversionEventForIndustry('e-commerce apparel').meta, 'Purchase');
  assert.strictEqual(launcher.conversionEventForIndustry('saas b2b').meta, 'CompleteRegistration');
  assert.strictEqual(launcher.conversionEventForIndustry('law firm').meta, 'Lead');
  assert.strictEqual(launcher.conversionEventForIndustry('unknown').meta, 'Lead'); // default
});

// ─── Launcher: bid strategy includes graduation thresholds ───────────────

test('launcher: initialBidStrategy starts as cost_cap with graduation thresholds', () => {
  const strat = launcher.initialBidStrategy({ industry: 'plumber', dailyBudget: 50 });
  assert.strictEqual(strat.type, 'cost_cap');
  assert.strictEqual(strat.daily_budget, 50);
  assert.strictEqual(strat.graduation_thresholds.to_bid_cap, 50);
  assert.strictEqual(strat.graduation_thresholds.to_manual, 200);
  assert.ok(strat.target_cpa > 0);
});

// ─── Launcher: naming convention ─────────────────────────────────────────

test('launcher: nameCampaign produces canonical taxonomy', () => {
  const date = new Date('2026-05-08T00:00:00Z');
  const name = launcher.nameCampaign({
    business: { business_name: 'Acme Dental Clinic!' },
    audienceLabel: 'lookalike_1pct',
    conceptKey: 'fresh-smile',
    platform: 'meta',
    date,
  });
  assert.strictEqual(name, 'acme-dental-clinic_lookalike_1pct_fresh-smile_meta_20260508');
});

// ─── Launcher: dry_run gating without env flag ───────────────────────────

test('launcher: coldStartLaunch is dry_run when META_AD_LAUNCH_LIVE not set', async () => {
  delete process.env.META_AD_LAUNCH_LIVE;
  const captured = [];
  const deps = {
    sbGet: async (table, q) => {
      if (table === 'businesses')
        return [
          {
            id: 'biz-x',
            business_name: 'X',
            industry: 'plumber',
            daily_budget: 30,
            country_code: 'US',
            location: 'Austin TX',
            competitors: [],
          },
        ];
      return [];
    },
    sbPost: async (table, row) => {
      captured.push({ table, row });
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sentry: null,
  };
  const r = await launcher.coldStartLaunch({
    businessId: 'biz-x',
    approvedConcept: { id: 'c1', concept: { headline: 'Hi', body: 'There' } },
    coldStartRunId: 'run-x',
    deps,
  });
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(r.platforms.length, 2); // $30/day → Meta + Google
  assert.strictEqual(r.launched, 6); // 2 platforms × 3 audiences
  assert.strictEqual(captured.length, 6);
  // Every persisted row should have status starting with 'planned_dry_run'
  for (const c of captured) {
    assert.ok(/planned_dry_run|pending_publish/.test(c.row.status));
  }
});
