'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { predictVirality, buildViralityPrompt, NEUTRAL } = require('../lib/viralityPredictor');

const extractJSON = (raw) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
};

test('buildViralityPrompt: includes hook, caption, platform, and JSON contract', () => {
  const p = buildViralityPrompt({
    platform: 'instagram_reel',
    hook: 'Stop scrolling',
    caption: 'Best coffee in town',
    media_url: 'https://x',
  });
  assert.match(p, /instagram_reel/);
  assert.match(p, /Stop scrolling/);
  assert.match(p, /Best coffee in town/);
  assert.match(p, /HAS_VISUAL: yes/);
  assert.match(p, /"virality_score"/);
});

test('predictVirality: parses + normalizes a well-formed model response', async () => {
  const deps = {
    callClaude: async () =>
      JSON.stringify({
        virality_score: 82,
        predicted_engagement: 'high',
        hook_strength: 'strong',
        retention_risk: 'low',
        rationale: 'Strong pattern-interrupt hook with a clear payoff.',
      }),
    extractJSON,
    logger: { warn() {} },
  };
  const r = await predictVirality({ content: { hook: 'x', caption: 'y' }, deps, businessId: 'b1' });
  assert.strictEqual(r.virality_score, 82);
  assert.strictEqual(r.predicted_engagement, 'high');
  assert.strictEqual(r.hook_strength, 'strong');
  assert.strictEqual(r.retention_risk, 'low');
  assert.ok(r.rationale.length > 0);
  assert.ok(r.raw);
});

test('predictVirality: clamps out-of-range score to 0..100', async () => {
  const deps = {
    callClaude: async () => JSON.stringify({ virality_score: 250, predicted_engagement: 'high' }),
    extractJSON,
  };
  const r = await predictVirality({ content: {}, deps });
  assert.strictEqual(r.virality_score, 100);

  const deps2 = {
    callClaude: async () => JSON.stringify({ virality_score: -40 }),
    extractJSON,
  };
  const r2 = await predictVirality({ content: {}, deps: deps2 });
  assert.strictEqual(r2.virality_score, 0);
});

test('predictVirality: coerces unknown enum values to safe defaults', async () => {
  const deps = {
    callClaude: async () =>
      JSON.stringify({
        virality_score: 60,
        predicted_engagement: 'stratospheric', // invalid
        hook_strength: 'BANANA', // invalid
        retention_risk: 'LOW', // valid but uppercase
      }),
    extractJSON,
  };
  const r = await predictVirality({ content: {}, deps });
  assert.strictEqual(r.predicted_engagement, 'medium');
  assert.strictEqual(r.hook_strength, 'moderate');
  assert.strictEqual(r.retention_risk, 'low', 'case-insensitive enum match');
});

test('predictVirality: returns NEUTRAL band when model throws', async () => {
  const deps = {
    callClaude: async () => {
      throw new Error('anthropic 503');
    },
    extractJSON,
    logger: { warn() {} },
  };
  const r = await predictVirality({ content: {}, deps });
  assert.deepStrictEqual(r, NEUTRAL);
});

test('predictVirality: returns NEUTRAL band when JSON is unparseable', async () => {
  const deps = {
    callClaude: async () => 'not json at all',
    extractJSON,
  };
  const r = await predictVirality({ content: {}, deps });
  assert.strictEqual(r.virality_score, NEUTRAL.virality_score);
  assert.strictEqual(r.raw, null);
});

test('predictVirality: returns NEUTRAL when callClaude/extractJSON missing (no crash)', async () => {
  const r = await predictVirality({ content: {}, deps: {} });
  assert.strictEqual(r.virality_score, NEUTRAL.virality_score);
});
