'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const createEngine = require('../services/wf1/engine');
const { buildBrandContext } = require('../services/wf1/brandContext');

// Regression test for the temporal-dead-zone bug in generateAssetForConcept:
// `postRationale` referenced `parsed` before its `const` declaration, throwing
// a ReferenceError on EVERY asset generation — before callClaude was ever
// reached. We drive the function past that site and assert callClaude is
// invoked (proof we cleared the old crash point) with no ReferenceError.
test('generateAssetForConcept reaches callClaude without a TDZ ReferenceError', async () => {
  const businessId = '11111111-1111-4111-8111-111111111111';
  const conceptId = 'concept-test-1';

  const callClaudeCalls = [];
  const modelOutput = JSON.stringify({
    caption: 'Test caption that sells without screaming.',
    hook: 'Stop scrolling — here is why.',
    visual_brief: 'Bright, high-contrast product photo, brand colors, rule of thirds.',
    hashtags: ['#test'],
    postingTime: { rationale: 'peak engagement window for this audience' },
    overall: 85,
    scores: { brand_voice: 18, hook: 17, visual_brief: 16, cta: 9, platform_fit: 9, compliance: 9 },
    banned_words_found: [],
  });

  const concept = {
    id: conceptId,
    business_id: businessId,
    platform: 'instagram',
    format: 'single_image',
    pillar: 'education',
    funnel_stage: 'awareness',
    emotion: 'curiosity',
    core_idea: 'Show the before/after of using the product.',
    hook: 'The 10-second fix',
    cta: 'Learn more',
    framework: 'AIDA',
    why_this_why_now: 'Seasonal demand spike',
    predicted_engagement_low: 2,
    predicted_engagement_high: 6,
    risk_level: 'low',
    cost_estimate_usd: 0.1,
    creative_concept_id: null,
  };

  const business = {
    id: businessId,
    business_name: 'Test Co',
    industry: 'fitness',
    brand_tone: 'expert',
    target_audience: 'busy professionals',
    plan: 'free', // free → adversarial critic is skipped (cost discipline)
  };

  const sbGet = async (table) => {
    if (table === 'content_concepts') return [concept];
    if (table === 'businesses') return [business];
    if (table === 'business_profiles') return [];
    return [];
  };

  const engine = createEngine({
    sbGet,
    sbPost: async () => [{ id: 'asset-test-1' }],
    sbPatch: async () => ({}),
    callClaude: async (user, model, maxTokens, opts) => {
      callClaudeCalls.push({ model, opts });
      return modelOutput;
    },
    extractJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    guardrails: { checkAll: async () => ({ allowed: true, reasons: [] }) },
    buildBrandContext,
    groundingContext: {
      buildGroundingContext: async () => ({
        toPromptBlock: () => '',
        postingSchedule: { best_times: ['09:00'] },
      }),
    },
    adversarialCritic: { critique: async (x) => x, rewrite: async (x) => x },
    metrics: { increment() {} },
  });

  let threw = null;
  try {
    await engine.generateAssetForConcept({ businessId, conceptId });
  } catch (e) {
    threw = e;
  }

  // The pre-fix bug crashed BEFORE callClaude — reaching it proves the fix.
  assert.ok(callClaudeCalls.length >= 1, 'callClaude should be reached (the old TDZ crashed before it)');
  if (threw) {
    assert.ok(!(threw instanceof ReferenceError), `must not throw a ReferenceError (TDZ regression): ${threw.stack}`);
    assert.ok(
      !/before initialization|parsed/i.test(threw.message),
      `must not throw the temporal-dead-zone error: ${threw.message}`
    );
  }
});

// Higgsfield image generation: generateAssetForConcept must turn the
// visual_brief into a real image via Higgsfield and persist it as media_url
// so the publisher has something to post. Higgsfield is the ONLY provider.
test('generateAssetForConcept renders a Higgsfield image and stores media_url', async () => {
  const businessId = '22222222-2222-4222-8222-222222222222';
  const conceptId = 'concept-img-1';

  const modelOutput = JSON.stringify({
    caption: 'Locally roasted, every morning.',
    hook: 'Your 7am, upgraded.',
    visualBrief: {
      style: 'Warm morning light, steam rising off a flat white on a marble counter',
      shots: ['close-up of the flat white', 'barista pour'],
      thumbnailGuidance: 'tight crop on the cup',
      brandAssets: ['logo bottom-right'],
    },
    hashtags: ['#coffee'],
    postingTime: { rationale: 'morning commute window' },
    overall: 88,
    scores: { brand_voice: 18, hook: 18, visual_brief: 17, cta: 9, platform_fit: 9, compliance: 9 },
    banned_words_found: [],
  });

  const concept = {
    id: conceptId,
    business_id: businessId,
    platform: 'instagram_feed',
    format: 'single_image',
    pillar: 'product',
    funnel_stage: 'awareness',
    emotion: 'desire',
    core_idea: 'Show the morning ritual.',
    hook: 'Your 7am, upgraded.',
    cta: 'Visit today',
    framework: 'PAS',
    why_this_why_now: 'Morning routine season',
    risk_level: 'low',
    creative_concept_id: null,
  };
  const business = { id: businessId, business_name: 'Cafe Test', industry: 'cafe', plan: 'free' };

  const posts = [];
  const generateImageCalls = [];

  const engine = createEngine({
    sbGet: async (table) => {
      if (table === 'content_concepts') return [concept];
      if (table === 'businesses') return [business];
      return [];
    },
    sbPost: async (table, row) => {
      posts.push({ table, row });
      return { id: 'asset-img-1' };
    },
    sbPatch: async () => ({}),
    callClaude: async () => modelOutput,
    extractJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    logger: { info() {}, warn() {}, error() {} },
    guardrails: { checkAll: async () => ({ allowed: true, reasons: [] }) },
    buildBrandContext,
    groundingContext: {
      buildGroundingContext: async () => ({ toPromptBlock: () => '', postingSchedule: { best_times: ['08:00'] } }),
    },
    adversarialCritic: { critique: async (x) => x, rewrite: async (x) => x },
    metrics: { increment() {} },
    higgsfield: {
      generateImage: async (args) => {
        generateImageCalls.push(args);
        return { url: 'https://cdn.higgsfield.ai/img/abc.png', model_used: 'nano-banana-pro', status: 'ready' };
      },
    },
  });

  await engine.generateAssetForConcept({ businessId, conceptId });

  // Higgsfield was called with the visual brief as the prompt + a feed aspect.
  assert.equal(generateImageCalls.length, 1, 'Higgsfield generateImage called exactly once');
  assert.match(generateImageCalls[0].prompt, /flat white|steam/i, 'prompt is the visual brief');
  assert.equal(generateImageCalls[0].aspect_ratio, '4:5', 'instagram_feed uses portrait 4:5');
  assert.equal(generateImageCalls[0].businessId, businessId, 'businessId passed for cost tracking');

  // The persisted content_assets row carries the real media_url.
  const assetInsert = posts.find((p) => p.table === 'content_assets');
  assert.ok(assetInsert, 'content_assets row was inserted');
  assert.equal(
    assetInsert.row.media_url,
    'https://cdn.higgsfield.ai/img/abc.png',
    'media_url persisted from Higgsfield'
  );
});

// ─── Higgsfield expansion: Soul ID + video routing + credit guard ──────────
function buildModelOutput() {
  return JSON.stringify({
    caption: 'Locally roasted, every morning.',
    hook: 'Your 7am, upgraded.',
    visualBrief: {
      style: 'Warm morning light',
      shots: ['close-up of the drink'],
      thumbnailGuidance: 'tight crop',
    },
    hashtags: ['#coffee'],
    postingTime: { rationale: 'morning commute' },
    overall: 88,
    scores: { brand_voice: 18, hook: 18, visual_brief: 17, cta: 9, platform_fit: 9, compliance: 9 },
    banned_words_found: [],
  });
}

function buildEngineHarness({ platform, biz, higgsfieldStub }) {
  const concept = {
    id: 'concept-x',
    business_id: biz.id,
    platform,
    format: 'single_image',
    pillar: 'product',
    funnel_stage: 'awareness',
    emotion: 'desire',
    core_idea: 'Show the morning ritual.',
    hook: 'Your 7am, upgraded.',
    cta: 'Visit today',
    framework: 'PAS',
    risk_level: 'low',
    creative_concept_id: null,
  };
  const posts = [];
  return {
    concept,
    posts,
    engine: createEngine({
      sbGet: async (table) => {
        if (table === 'content_concepts') return [concept];
        if (table === 'businesses') return [biz];
        return [];
      },
      sbPost: async (table, row) => {
        posts.push({ table, row });
        return { id: 'asset-x' };
      },
      sbPatch: async () => ({}),
      callClaude: async () => buildModelOutput(),
      extractJSON: (raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },
      logger: { info() {}, warn() {}, error() {} },
      guardrails: { checkAll: async () => ({ allowed: true, reasons: [] }) },
      buildBrandContext,
      groundingContext: {
        buildGroundingContext: async () => ({
          toPromptBlock: () => '',
          postingSchedule: { best_times: ['08:00'] },
        }),
      },
      adversarialCritic: { critique: async (x) => x, rewrite: async (x) => x },
      metrics: { increment() {} },
      higgsfield: higgsfieldStub,
    }),
  };
}

test('Soul ID is attached to generateImage when business has higgsfield_soul_id', async () => {
  const biz = {
    id: '33333333-3333-4333-8333-333333333333',
    business_name: 'Cafe Test',
    industry: 'cafe',
    plan: 'free',
    higgsfield_soul_id: 'soul-xyz',
    higgsfield_credits: 800,
  };
  const imageCalls = [];
  const { engine, concept } = buildEngineHarness({
    platform: 'instagram_feed',
    biz,
    higgsfieldStub: {
      generateImage: async (args) => {
        imageCalls.push(args);
        return { url: 'https://cdn.higgsfield.ai/img/x.png', model_used: 'nano-banana-pro' };
      },
    },
  });
  await engine.generateAssetForConcept({ businessId: biz.id, conceptId: concept.id });
  assert.equal(imageCalls.length, 1, 'generateImage called once for feed platform');
  assert.equal(imageCalls[0].soul_id, 'soul-xyz', 'soul_id threaded into Higgsfield call');
  assert.equal(imageCalls[0].aspect_ratio, '4:5', 'feed aspect ratio');
});

test('Reel platform routes through generateVideo (9:16 + duration 6 + seedance + soul)', async () => {
  const biz = {
    id: '44444444-4444-4444-8444-444444444444',
    business_name: 'Cafe Test',
    industry: 'cafe',
    plan: 'free',
    higgsfield_soul_id: 'soul-reel',
    higgsfield_credits: 500,
  };
  const imageCalls = [];
  const videoCalls = [];
  const { engine, concept, posts } = buildEngineHarness({
    platform: 'instagram_reel',
    biz,
    higgsfieldStub: {
      generateImage: async (a) => {
        imageCalls.push(a);
        return { url: 'X' };
      },
      generateVideo: async (a) => {
        videoCalls.push(a);
        return { url: 'https://cdn.higgsfield.ai/v/clip.mp4', model_used: 'seedance-2.0' };
      },
    },
  });
  await engine.generateAssetForConcept({ businessId: biz.id, conceptId: concept.id });
  assert.equal(imageCalls.length, 0, 'generateImage NOT called for reel platform');
  assert.equal(videoCalls.length, 1, 'generateVideo called for reel');
  assert.equal(videoCalls[0].aspect_ratio, '9:16');
  assert.equal(videoCalls[0].durationSeconds, 6);
  assert.equal(videoCalls[0].model, 'seedance-2.0', 'social reel uses seedance');
  assert.equal(videoCalls[0].soul_id, 'soul-reel');
  const assetInsert = posts.find((p) => p.table === 'content_assets');
  assert.equal(assetInsert.row.media_url, 'https://cdn.higgsfield.ai/v/clip.mp4');
});

test('Credit guard blocks generation when higgsfield_credits < 100', async () => {
  const biz = {
    id: '55555555-5555-4555-8555-555555555555',
    business_name: 'Cafe Test',
    industry: 'cafe',
    plan: 'free',
    higgsfield_credits: 42,
  };
  const imageCalls = [];
  const videoCalls = [];
  const { engine, concept, posts } = buildEngineHarness({
    platform: 'instagram_feed',
    biz,
    higgsfieldStub: {
      generateImage: async (a) => {
        imageCalls.push(a);
        return { url: 'should-not-happen' };
      },
      generateVideo: async (a) => {
        videoCalls.push(a);
        return { url: 'should-not-happen' };
      },
    },
  });
  await engine.generateAssetForConcept({ businessId: biz.id, conceptId: concept.id });
  assert.equal(imageCalls.length, 0, 'image generation skipped when credits low');
  assert.equal(videoCalls.length, 0, 'video generation skipped when credits low');
  const assetInsert = posts.find((p) => p.table === 'content_assets');
  assert.ok(assetInsert, 'asset still persisted so caption work is salvaged');
  assert.equal(assetInsert.row.media_url, null, 'media_url null when generation was credit-blocked');
  const blockEvent = posts.find((p) => p.table === 'events' && p.row.kind === 'higgsfield.credits.low.blocked');
  assert.ok(blockEvent, 'low-credits block event written');
  assert.equal(blockEvent.row.payload.credits, 42);
});
