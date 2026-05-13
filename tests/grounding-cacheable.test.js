'use strict';

/**
 * tests/grounding-cacheable.test.js
 *
 * Wave 59 Session 2 — verifies the cacheable-blocks shape returned by
 * groundingContext for Anthropic prompt caching.
 */

const test = require('node:test');
const assert = require('node:assert');

const gc = require('../lib/groundingContext');

test('grounding S2: empty context returns empty cacheable blocks', async () => {
  const ctx = await gc.buildGroundingContext({});
  assert.deepStrictEqual(ctx.toCacheableBlocks(), []);
});

test('grounding S2: non-corpus context returns one uncached block', async () => {
  gc._resetCache();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'brand_voice_anchors') return [{ anchor: { tone_descriptors: 'warm, direct' } }];
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
  });
  const blocks = ctx.toCacheableBlocks();
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'text');
  assert.strictEqual(blocks[0].cache_control, undefined, 'non-corpus block must not be cached alone');
  assert.match(blocks[0].text, /Brand voice anchor/);
});

test('grounding S2: corpus block is tagged with cache_control: ephemeral', async () => {
  gc._resetCache();
  const stubMemory = {
    findSimilar: async () => [],
  };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'marketing_corpus') {
      return [
        {
          id: 'mc1',
          title: 'Liquid Death campaign',
          body: 'Murder your thirst — example expert ad body',
          industry: 'cafe',
          region: 'US',
          quality_score: 0.95,
          source: 'meta_ad_library',
        },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe morning ad',
    performanceMemory: stubMemory,
  });
  const blocks = ctx.toCacheableBlocks();
  // Should have 1 block: the corpus block with cache_control.
  const corpusBlocks = blocks.filter((b) => b.cache_control);
  assert.strictEqual(corpusBlocks.length, 1, 'exactly one block must be cacheable');
  assert.strictEqual(corpusBlocks[0].cache_control.type, 'ephemeral');
  assert.match(corpusBlocks[0].text, /Expert corpus/);
  assert.match(corpusBlocks[0].text, /Murder your thirst/);
});

test('grounding S2: corpus + non-corpus segregation', async () => {
  gc._resetCache();
  const stubMemory = { findSimilar: async () => [] };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'brand_voice_anchors') return [{ anchor: { tone_descriptors: 'warm' } }];
    if (table === 'marketing_corpus') {
      return [
        {
          id: 'mc1',
          body: 'Expert ad body 1 — specific 12,847 customers',
          industry: 'cafe',
          region: 'US',
          quality_score: 0.9,
        },
      ];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    performanceMemory: stubMemory,
  });
  const blocks = ctx.toCacheableBlocks();
  assert.strictEqual(blocks.length, 2);
  // First = non-corpus (uncached), second = corpus (cached)
  assert.strictEqual(blocks[0].cache_control, undefined);
  assert.match(blocks[0].text, /Brand voice anchor/);
  assert.ok(blocks[1].cache_control);
  assert.match(blocks[1].text, /Expert corpus/);
  // Make sure corpus content is NOT also in the non-corpus block
  assert.ok(!/Expert corpus/.test(blocks[0].text));
});

test('grounding S2: drops empty segments', async () => {
  // A grounding context with only corpus content (no brand/voc/wins/etc)
  // should produce ONE block — the corpus — not an empty non-corpus block.
  gc._resetCache();
  const stubMemory = { findSimilar: async () => [] };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'marketing_corpus') {
      return [{ id: 'mc1', body: 'Expert ad body', industry: 'cafe', region: 'US', quality_score: 0.9 }];
    }
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'something',
    performanceMemory: stubMemory,
  });
  const blocks = ctx.toCacheableBlocks();
  // Only the corpus block should remain
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].cache_control);
});

test('grounding S2: toPromptBlock backwards-compatible single string still works', async () => {
  gc._resetCache();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'brand_voice_anchors') return [{ anchor: { tone_descriptors: 'warm' } }];
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
  });
  const single = ctx.toPromptBlock();
  assert.match(single, /Brand voice anchor/);
  assert.ok(typeof single === 'string');
});
