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
