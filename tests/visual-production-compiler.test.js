'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  makeVisualProductionCompiler,
  MODEL_ROUTING,
  PLATFORM_FORMAT,
  HOOK_DIRECTING,
  VALID_INTENTS,
} = require('../lib/visualProductionCompiler');

function makeStubGraph() {
  const entities = [];
  return {
    entities,
    upsertEntity: async (spec) => {
      const row = { id: `e-${entities.length + 1}`, ...spec, attrs: spec.attrs || {} };
      // Match by externalId for idempotency
      const i = entities.findIndex((e) => e.externalId && e.externalId === spec.externalId);
      if (i >= 0) {
        Object.assign(entities[i], spec);
        return entities[i];
      }
      entities.push(row);
      return row;
    },
    getEntitiesByType: async ({ businessId, type, limit }) => {
      return entities.filter((e) => e.businessId === businessId && e.type === type).slice(0, limit || 50);
    },
  };
}

function makeStubDecisionLog() {
  const decisions = [];
  return {
    decisions,
    proposeDecision: async (d) => {
      const row = { id: `d-${decisions.length + 1}`, ...d };
      decisions.push(row);
      return row;
    },
  };
}

function makeStubCompliance(violations = []) {
  return {
    applyCompliance: ({ draft, industry }) => ({
      ok: violations.length === 0,
      violations,
      rulesets_applied: industry === 'cafe' ? [] : ['some-ruleset'],
    }),
  };
}

// ─── Construction ─────────────────────────────────────────────────────────

test('compiler: requires marketingGraph dep', () => {
  assert.throws(() => makeVisualProductionCompiler({}), /marketingGraph dep required/);
});

test('compiler: exports model routing for all valid intents', () => {
  for (const intent of VALID_INTENTS) {
    assert.ok(MODEL_ROUTING[intent], `missing routing for ${intent}`);
    assert.ok(MODEL_ROUTING[intent].quality?.primary, `${intent} missing quality.primary`);
    assert.ok(MODEL_ROUTING[intent].cost?.primary, `${intent} missing cost.primary`);
  }
});

test('compiler: exports HOOK_DIRECTING for the 8 Creative Genome hook types', () => {
  const hooks = [
    'pattern_interrupt',
    'curiosity',
    'social_proof',
    'fear_relief',
    'authority',
    'aspiration',
    'scarcity',
    'reciprocity',
  ];
  for (const h of hooks) {
    assert.ok(HOOK_DIRECTING[h], `missing hook directing for ${h}`);
    assert.ok(HOOK_DIRECTING[h].opener);
    assert.ok(HOOK_DIRECTING[h].motion);
  }
});

test('compiler: PLATFORM_FORMAT covers the main channels', () => {
  const needed = ['meta-ads-image', 'meta-ads-video', 'instagram-reels', 'tiktok', 'youtube-shorts'];
  for (const ch of needed) {
    assert.ok(PLATFORM_FORMAT[ch], `missing format for ${ch}`);
  }
});

// ─── compileVisualBrief ───────────────────────────────────────────────────

test('compileVisualBrief: soft-fails on missing businessId', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({ intent: 'meta_ad_video' });
  assert.strictEqual(r._soft, true);
  assert.match(r.reason, /required/);
});

test('compileVisualBrief: soft-fails on invalid intent', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({ businessId: 'b', intent: 'bogus' });
  assert.strictEqual(r._soft, true);
  assert.match(r.reason, /intent must be/);
});

test('compileVisualBrief: meta_ad_video produces a JobSpec with 9:16 video', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b-1',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    industry: 'cafe',
    hookType: 'curiosity',
  });
  assert.ok(r.jobSpec);
  assert.strictEqual(r.jobSpec.aspect_ratio, '9:16');
  assert.strictEqual(r.jobSpec.duration_sec, 15);
  assert.strictEqual(r.jobSpec.captions_required, true);
  assert.ok(r.jobSpec.prompt.length > 50);
  assert.ok(r.jobSpec.negative_prompt.includes('blurry'));
});

test('compileVisualBrief: priority=cost routes to cheaper model', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const cost = await c.compileVisualBrief({
    businessId: 'b-1',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    priority: 'cost',
  });
  const quality = await c.compileVisualBrief({
    businessId: 'b-1',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    priority: 'quality',
  });
  assert.ok(
    cost.jobSpec.cost_estimate_usd < quality.jobSpec.cost_estimate_usd,
    `cost (${cost.jobSpec.cost_estimate_usd}) should be cheaper than quality (${quality.jobSpec.cost_estimate_usd})`
  );
});

test('compileVisualBrief: uses cached brand DNA when available', async () => {
  const graph = makeStubGraph();
  await graph.upsertEntity({
    businessId: 'b-1',
    type: 'brand_visual_dna',
    title: 'DNA',
    externalId: 'brand_visual_dna:b-1',
    attrs: { soul_id: 'soul-xyz', palette: ['#FF6600', '#222222'], style_anchors: ['minimal', 'warm'] },
  });
  // Mark status to active so the type-filter returns it
  graph.entities[0].status = 'active';

  const c = makeVisualProductionCompiler({ marketingGraph: graph });
  const r = await c.compileVisualBrief({
    businessId: 'b-1',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
  });
  assert.strictEqual(r.jobSpec.soul_id, 'soul-xyz');
  assert.match(r.brief.brand_consistency_notes, /cached brand DNA/);
  assert.match(r.jobSpec.prompt, /minimal|warm/);
});

test('compileVisualBrief: warns when no brand DNA cached', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b-1',
    intent: 'product_photo',
    channel: 'meta-ads-image',
  });
  assert.strictEqual(r.jobSpec.soul_id, null);
  assert.match(r.brief.brand_consistency_notes, /No brand DNA cached/);
});

test('compileVisualBrief: emits fallback model spec', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
  });
  assert.ok(r.fallback);
  assert.notStrictEqual(r.fallback.model, r.jobSpec.model);
  assert.match(r.fallback.reason, /primary/i);
});

test('compileVisualBrief: shot list shaped to duration', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const shortV = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'instagram_reel',
    channel: 'instagram-reels',
  });
  assert.strictEqual(shortV.brief.shot_list.length, 3); // 3-beat structure
  const longV = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'youtube-long',
  });
  assert.strictEqual(longV.brief.shot_list.length, 5); // hook+3beats+CTA
});

test('compileVisualBrief: image intents produce single-frame shot list', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'product_photo',
    channel: 'meta-ads-image',
  });
  assert.strictEqual(r.brief.shot_list.length, 1);
  assert.strictEqual(r.jobSpec.duration_sec, null);
});

test('compileVisualBrief: QA checklist includes platform aspect-ratio check', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'tiktok_video',
    channel: 'tiktok',
    industry: 'cafe',
  });
  assert.ok(r.qa_checklist.length >= 5);
  assert.ok(r.qa_checklist.some((c) => /Aspect ratio/i.test(c.check)));
  assert.ok(r.qa_checklist.some((c) => /captions/i.test(c.check)));
});

test('compileVisualBrief: writes decision_logs row when decisionLog is wired', async () => {
  const dl = makeStubDecisionLog();
  const c = makeVisualProductionCompiler({
    marketingGraph: makeStubGraph(),
    decisionLog: dl,
  });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
  });
  assert.strictEqual(dl.decisions.length, 1);
  // Stub stores raw camelCase args; real lib/decisionLog.js transforms to snake_case
  // before INSERT. Either field name accepted here:
  const d = dl.decisions[0];
  assert.strictEqual(d.agentName || d.agent_name, 'visual-production-compiler');
  assert.strictEqual(d.decisionSubtype || d.decision_subtype, 'meta_ad_video');
  assert.ok(r.decision_log_id);
});

test('compileVisualBrief: compliance violation blocks compile', async () => {
  const c = makeVisualProductionCompiler({
    marketingGraph: makeStubGraph(),
    compliance: makeStubCompliance([{ severity: 'block', issue: 'banned mortgage approval claim' }]),
  });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    industry: 'mortgage_broker',
  });
  assert.strictEqual(r._soft, true);
  assert.strictEqual(r.reason, 'compliance_block');
  assert.strictEqual(r.violations.length, 1);
});

test('compileVisualBrief: includes reasoning_trace for transparency', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
  });
  assert.ok(Array.isArray(r.reasoning_trace));
  assert.ok(r.reasoning_trace.length >= 3);
  assert.ok(r.reasoning_trace.some((t) => /model/i.test(t)));
});

// ─── Brand Visual DNA caching ─────────────────────────────────────────────

test('cacheBrandVisualDna: requires businessId', () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  assert.rejects(() => c.cacheBrandVisualDna({}), /businessId required/);
});

test('cacheBrandVisualDna: requires at least one DNA field', () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  assert.rejects(() => c.cacheBrandVisualDna({ businessId: 'b' }), /at least one/);
});

test('cacheBrandVisualDna: stores soul_id + palette in attrs', async () => {
  const graph = makeStubGraph();
  const c = makeVisualProductionCompiler({ marketingGraph: graph });
  const r = await c.cacheBrandVisualDna({
    businessId: 'b-1',
    soulId: 'soul-abc',
    palette: ['#FF6600', '#222222'],
    styleAnchors: ['warm', 'minimal'],
  });
  assert.ok(r);
  assert.strictEqual(r.attrs.soul_id, 'soul-abc');
  assert.deepStrictEqual(r.attrs.palette, ['#FF6600', '#222222']);
  assert.ok(r.attrs.cached_at);
});

test('cacheBrandVisualDna: idempotent (upsert by externalId)', async () => {
  const graph = makeStubGraph();
  const c = makeVisualProductionCompiler({ marketingGraph: graph });
  await c.cacheBrandVisualDna({ businessId: 'b-1', soulId: 'soul-1' });
  await c.cacheBrandVisualDna({ businessId: 'b-1', soulId: 'soul-2' });
  assert.strictEqual(graph.entities.length, 1, 'should not create duplicate row');
});

test('getBrandVisualDna: returns null when none cached', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  assert.strictEqual(await c.getBrandVisualDna('b-1'), null);
});

// ─── Hook directing ───────────────────────────────────────────────────────

test('compileVisualBrief: fear_relief hook produces "problem shown plainly" opener', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    hookType: 'fear_relief',
  });
  assert.match(r.brief.hook.opener, /problem shown plainly/i);
});

test('compileVisualBrief: scarcity hook adds deadline QA check', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
    hookType: 'scarcity',
  });
  assert.ok(r.qa_checklist.some((c) => /deadline/i.test(c.check)));
});

// ─── Defensive ───────────────────────────────────────────────────────────

test('compileVisualBrief: works without decisionLog dep', async () => {
  const c = makeVisualProductionCompiler({ marketingGraph: makeStubGraph() });
  const r = await c.compileVisualBrief({
    businessId: 'b',
    intent: 'meta_ad_video',
    channel: 'meta-ads-video',
  });
  assert.ok(r.jobSpec);
  assert.strictEqual(r.decision_log_id, null);
});
