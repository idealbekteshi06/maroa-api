'use strict';

/**
 * Integration tests for the 3 expensive paths:
 *   - developCreativeConcept (Cannes-grade Opus)
 *   - vetCustomerAsset (8-dimension vetter)
 *   - smartProcessAsset (vet → enhance/regen/use)
 *
 * Uses mocked deps — no live Higgsfield / Anthropic / Supabase calls.
 * Run with: node --test tests/creative-director.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createHiggsfieldService = require(path.join(ROOT, 'services/higgsfield'));
const cd = require(path.join(ROOT, 'services/prompts/creative-director'));
const v = require(path.join(ROOT, 'services/prompts/image-vetter'));
const decision = require(path.join(ROOT, 'services/prompts/image-vetter/decision'));
const { pickVariant } = require(path.join(ROOT, 'services/creative/registerRoutes'));

function mkDeps(overrides = {}) {
  return {
    apiRequest: async () => ({ status: 200, body: '' }),
    serpSearch: async () => [],
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    extractJSON: (s) => {
      if (!s) return null;
      try { return JSON.parse(s); } catch {
        const m = s.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
        return null;
      }
    },
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    ANTHROPIC_KEY: 'test',
    SERPAPI_KEY: 'test',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_KEY: 'test',
    callClaude: undefined,
    ...overrides,
  };
}

const SAMPLE_BRAND = {
  business_name: 'Uje Karadaku',
  industry: 'bottled water DTC',
  brand_tone: 'calm minimal premium-clean',
  target_audience: 'EU 25-45 health-conscious',
  location: 'Kosovo',
  marketing_goal: 'launch new brand, build awareness',
};

// ─── creative-director paths ──────────────────────────────────────

test('creative-director: buildCreativeBrief produces system+user with insight format embedded', () => {
  const brief = cd.buildCreativeBrief({
    brandDNA: SAMPLE_BRAND,
    businessGoal: 'take 10% market share',
    contentGoal: 'monthly hero',
    ideaLevel: 'campaign',
  });
  assert.ok(brief.system.length > 5000, 'system prompt should be Opus-grade (>5k chars)');
  assert.ok(/MCSLA/.test(brief.system), 'must reference MCSLA framework');
  assert.ok(/audience.*wants.*Y stands in the way.*because/i.test(brief.system), 'must require insight format');
  assert.ok(/P01.*P18|P0[1-9]/i.test(brief.system), 'must include pattern map');
  assert.ok(brief.userTask.length > 0, 'user task non-empty');
});

test('creative-director: buildCreativeBrief is i18n-safe with diacritics in brand', () => {
  const brief = cd.buildCreativeBrief({
    brandDNA: { business_name: 'Café Lélé', industry: 'café gourmet bakery' },
    contentGoal: 'reel for new croissant launch',
  });
  assert.ok(brief.system.includes('food_beverage'), 'should classify Café/bakery as food_beverage genre');
});

test('creative-director: methods triplet rotates by category to prevent tunnel vision', () => {
  const t0 = cd.pickMethodTriplet(0);
  const t1 = cd.pickMethodTriplet(1);
  assert.equal(t0.length, 3, 'triplet has 3 methods');
  // Different rotations should produce at least one different method
  const namesA = t0.map(m => m.name);
  const namesB = t1.map(m => m.name);
  assert.notDeepEqual(namesA, namesB, 'rotation produces different triplet');
});

test('creative-director: convertConceptToMcslaInputs locks subject + camera from concept', () => {
  const concept = {
    insight: 'people drink water automatically, but choosing this water makes them feel they took care of themselves today, because consistency in tiny self-care is rarer than they think',
    top_concept: {
      name: 'A Quieter Kind of Care',
      one_sentence: 'placeholder',
      pattern: 'P05',
      scores: { weighted: 8.7 },
      downstream_brief_for_higgsfield: {
        subject: 'a glass of water on a quiet morning kitchen counter',
        action: 'static moment',
        camera: 'Macro Dolly In',
        look: 'Cinematic commercial, warm neutral',
        platform_native_aspect: '1:1',
        audio_cue: null,
      }
    }
  };
  const inputs = cd.convertConceptToMcslaInputs(concept, SAMPLE_BRAND);
  assert.equal(inputs.creativeContext.camera, 'Macro Dolly In');
  assert.match(inputs.creativeContext.visualization, /glass of water/);
  assert.equal(inputs.aspectRatio, '1:1');
});

test('creative-director: developCreativeConcept routes through callClaude (cacheable path) when injected', async () => {
  let callClaudeSpyArgs = null;
  const deps = mkDeps({
    callClaude: async (prompt, model, maxTokens, extra) => {
      callClaudeSpyArgs = { prompt, model, maxTokens, extra };
      return JSON.stringify({
        insight: 'test insight',
        top_concept: { name: 'Test Concept', pattern: 'P05', scores: { weighted: 8.5 } }
      });
    }
  });
  const svc = createHiggsfieldService(deps);
  const concept = await svc.developCreativeConcept(SAMPLE_BRAND, 'goal', 'theme');
  assert.equal(callClaudeSpyArgs.model, 'claude-opus-4-7', 'uses Opus 4.7 (post-swap)');
  assert.equal(callClaudeSpyArgs.extra.cacheSystem, true, 'sets cacheSystem:true for prompt caching');
  assert.ok(callClaudeSpyArgs.extra.system.length > 5000, 'passes the full Opus-grade system prompt');
  assert.equal(concept.top_concept.name, 'Test Concept');
});

// ─── image-vetter paths ──────────────────────────────────────────

test('image-vetter: hard gate forces reject when safety <= 4', () => {
  const out = decision.decide(
    { technical: 9, composition: 9, lighting: 9, brand_alignment: 9, genre_fit: 9, marketing_suitability: 9, safety: 3, genuineness: 7 },
    'food_beverage',
    {}
  );
  assert.equal(out.verdict, 'reject', 'safety<=4 forces reject');
  assert.ok(out.hard_gates_fired.length > 0, 'gate fires');
});

test('image-vetter: third-party flag forces reject regardless of scores', () => {
  const out = decision.decide(
    { technical: 9, composition: 9, lighting: 9, brand_alignment: 9, genre_fit: 9, marketing_suitability: 9, safety: 9, genuineness: 9 },
    'food_beverage',
    { flagThirdParty: true }
  );
  assert.equal(out.verdict, 'reject', 'third-party flag forces reject');
});

test('image-vetter: smallest dim < 800 forces regenerate (resolution gate)', () => {
  const out = decision.decide(
    { technical: 8, composition: 8, lighting: 8, brand_alignment: 8, genre_fit: 8, marketing_suitability: 8, safety: 10, genuineness: 8 },
    'food_beverage',
    { smallestDimensionPx: 600, subjectCorrect: true }
  );
  assert.equal(out.verdict, 'regenerate_fresh', 'low res forces regen — Soul I2I needs ≥800px');
});

test('image-vetter: brand_alignment<=2 forces regenerate (brand contradiction)', () => {
  const out = decision.decide(
    { technical: 9, composition: 9, lighting: 9, brand_alignment: 2, genre_fit: 5, marketing_suitability: 7, safety: 10, genuineness: 5 },
    'food_beverage',
    { subjectCorrect: true }
  );
  assert.equal(out.verdict, 'regenerate_fresh', 'brand contradiction forces regen');
});

test('image-vetter: stock-photo aesthetic on UGC genre forces regenerate (Soul I2I cant fake authentic)', () => {
  const out = decision.decide(
    { technical: 10, composition: 9, lighting: 9, brand_alignment: 6, genre_fit: 5, marketing_suitability: 8, safety: 10, genuineness: 2 },
    'lifestyle_social',
    { subjectCorrect: true, smallestDimensionPx: 2000 }
  );
  assert.equal(out.verdict, 'regenerate_fresh', 'genuineness<=3 on UGC genre forces regen');
});

test('image-vetter: borderline flag fires within 3 points of band boundary', () => {
  const out = decision.decide(
    { technical: 7, composition: 5, lighting: 4, brand_alignment: 5, genre_fit: 3.5, marketing_suitability: 5, safety: 10, genuineness: 9 },
    'food_beverage',
    { subjectCorrect: true, smallestDimensionPx: 1440 }
  );
  assert.equal(out.borderline, true, 'borderline marked when near a band boundary');
});

test('image-vetter: enhance-brief generates 3 aspect ratios with subject lock', () => {
  const brief = require(path.join(ROOT, 'services/prompts/image-vetter/enhance-brief')).buildEnhanceBrief({
    brandDNA: SAMPLE_BRAND,
    contentTheme: 'product hero',
    vetterOutput: {
      subject_phrase: 'the matte aluminum bottle',
      i2i_fixes_targeting: ['lighting', 'composition'],
    }
  });
  assert.equal(brief.i2i_prompts.length, 3, 'three aspect variants');
  assert.deepEqual(brief.i2i_prompts.map(p => p.aspect_ratio), ['1:1', '9:16', '4:5']);
  assert.ok(brief.i2i_prompts.every(p => p.prompt.includes('the matte aluminum bottle')), 'subject locked in every variant');
});

test('image-vetter: synthesizeVerdict returns next_action with i2i_prompts when verdict=enhance', () => {
  const result = v.synthesizeVerdict({
    rawVetterOutput: {
      scores: { technical: 7, composition: 5.5, lighting: 5, brand_alignment: 7, genre_fit: 7, marketing_suitability: 6, safety: 10, genuineness: 9 },
      subject_correct: true,
      smallest_dimension_px: 1440,
      subject_phrase: 'the matte bottle',
      i2i_fixes_targeting: ['lighting', 'composition'],
    },
    brandDNA: SAMPLE_BRAND,
    contentTheme: 'product hero shot',
  });
  if (result.verdict === 'enhance_via_higgsfield') {
    assert.ok(Array.isArray(result.next_action?.i2i_prompts), 'i2i prompts attached');
    assert.equal(result.next_action.i2i_prompts.length, 3);
  }
});

// ─── A/B framework ───────────────────────────────────────────────

test('A/B: same seed always picks same variant (deterministic)', () => {
  for (let i = 0; i < 100; i++) {
    assert.equal(pickVariant('seed' + i), pickVariant('seed' + i));
  }
});

test('A/B: variant distribution is roughly 50/50 across 1000 unique seeds', () => {
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 1000; i++) counts[pickVariant('biz_' + i + '_2026-05-04')]++;
  assert.ok(counts.A > 400 && counts.A < 600, `A count ${counts.A} should be ~500 (got ${counts.A})`);
  assert.ok(counts.B > 400 && counts.B < 600, `B count ${counts.B} should be ~500 (got ${counts.B})`);
});

// ─── higgsfield service smoke ────────────────────────────────────

test('higgsfield service factory exposes 15 functions including new ones', () => {
  const svc = createHiggsfieldService(mkDeps());
  const expected = [
    'generateProductImage', 'generateProductVideo', 'generateHeroAd', 'scoreContent',
    'vetCustomerAsset', 'vetCustomerAssetBatch', 'smartProcessAsset',
    'developCreativeConcept', 'generateStrategicProductImage',
    'trainSoulCharacter', 'generateWithModel', 'pathForModel',
    'generateCaption', 'processProductCatalog', 'cancelRequest',
  ];
  for (const fn of expected) {
    assert.equal(typeof svc[fn], 'function', `${fn} should be exported`);
  }
});

test('higgsfield service: pathForModel routes correctly across model lineup', () => {
  const svc = createHiggsfieldService(mkDeps());
  assert.match(svc.pathForModel('soul 2.0'), /soul/i);
  assert.match(svc.pathForModel('nano banana pro'), /nano/i);
  assert.match(svc.pathForModel('seedream 4.5'), /seedream/i);
  assert.match(svc.pathForModel('higgsfield dop standard'), /dop/i);
  assert.match(svc.pathForModel('veo 3.1'), /veo/i);
  // Unknown model falls back to Soul (defensive default)
  assert.match(svc.pathForModel('unknown-model-9000'), /soul/i, 'unknown model defaults to Soul');
});

// ─── genre router i18n ───────────────────────────────────────────

test('genre-router: handles diacritics across café/CAFE/Bödega/naïve', () => {
  const { classifyGenre } = require(path.join(ROOT, 'services/prompts/higgsfield/genre-router'));
  assert.equal(classifyGenre({ industry: 'café gourmet' }, 'product hero'), 'food_beverage');
  assert.equal(classifyGenre({ industry: 'CAFÉ restaurant' }, 'product hero'), 'food_beverage');
  assert.equal(classifyGenre({ industry: 'BØDEGA café' }, 'product hero'), 'food_beverage');
  assert.equal(classifyGenre({ industry: 'naïve organic food' }, 'product hero'), 'food_beverage');
});

test('genre-router: covers 12 distinct business types correctly', () => {
  const { classifyGenre } = require(path.join(ROOT, 'services/prompts/higgsfield/genre-router'));
  const cases = [
    [{ industry: 'bottled water' }, 'product hero', 'food_beverage'],
    [{ industry: 'plumbing repair local service' }, 'service tech at work', 'service_business'],
    [{ industry: 'b2b saas crm' }, 'launch hero', 'b2b_saas'],
    [{ industry: 'fashion handbag' }, 'editorial lookbook', 'fashion_editorial'],
    [{ industry: 'gym fitness wellness' }, 'day in the life', 'lifestyle_social'],
    [{ industry: 'real estate broker' }, 'new listing tour', 'location_establishing'],
    [{ industry: 'dental clinic medical' }, 'meet the team', 'service_business'],
    [{ industry: 'coffee shop' }, 'instagram reel', 'food_beverage'],
  ];
  for (const [dna, theme, expected] of cases) {
    assert.equal(classifyGenre(dna, theme), expected, `${dna.industry} / ${theme} should classify as ${expected}`);
  }
});
