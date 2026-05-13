'use strict';

/**
 * tests/grounding-cold-start-switch.test.js
 *
 * Wave 59 Session 4 — verifies the cold-start switch:
 *   - < 50 published pieces → corpus injected (cold_start mode)
 *   - ≥ 50 published pieces → corpus skipped (warm mode)
 *   - Always exposes groundingMode + publishedCount on the context
 */

const test = require('node:test');
const assert = require('node:assert');

const gc = require('../lib/groundingContext');

function makeFakeSbGet({ publishedCount, plan = 'agency' } = {}) {
  return async (table, query = '') => {
    if (table === 'businesses') {
      return [{ id: 'biz1', industry: 'cafe', country: 'US', plan }];
    }
    if (table === 'generated_content' && query.includes('status=eq.published')) {
      // Return `publishedCount` row stubs
      return Array.from({ length: publishedCount }, (_, i) => ({ id: `c${i}` }));
    }
    if (table === 'marketing_corpus') {
      return [
        { id: 'mc1', body: 'Expert ad 1', industry: 'cafe', region: 'US', quality_score: 0.9 },
        { id: 'mc2', body: 'Expert ad 2', industry: 'cafe', region: 'US', quality_score: 0.85 },
      ];
    }
    return [];
  };
}

// ─── COLD_START_THRESHOLD constant ─────────────────────────────────────────

test('S4: COLD_START_THRESHOLD is exported and set to 50', () => {
  assert.strictEqual(gc.COLD_START_THRESHOLD, 50);
});

// ─── countPublishedContent ─────────────────────────────────────────────────

test('S4: countPublishedContent returns 0 when sbGet or businessId missing', async () => {
  assert.strictEqual(await gc.countPublishedContent({}), 0);
  assert.strictEqual(await gc.countPublishedContent({ sbGet: async () => [] }), 0);
});

test('S4: countPublishedContent returns the array length', async () => {
  const count = await gc.countPublishedContent({
    sbGet: makeFakeSbGet({ publishedCount: 30 }),
    businessId: 'biz1',
  });
  assert.strictEqual(count, 30);
});

test('S4: countPublishedContent returns 0 on sbGet throw (conservative cold-start fallback)', async () => {
  const sbGet = async () => {
    throw new Error('db down');
  };
  const count = await gc.countPublishedContent({ sbGet, businessId: 'biz1' });
  assert.strictEqual(count, 0);
});

// ─── buildGroundingContext: cold-start switch ──────────────────────────────

test('S4: cold-start (count=0) → corpus injected, mode=cold_start', async () => {
  gc._resetCache();
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 0 }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  assert.strictEqual(ctx.groundingMode, 'cold_start');
  assert.strictEqual(ctx.coldStartActive, true);
  assert.strictEqual(ctx.publishedCount, 0);
  assert.ok(ctx.expertCorpus.length > 0, 'corpus must be injected when cold');
});

test('S4: count below threshold (count=49) → still cold_start, corpus on', async () => {
  gc._resetCache();
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 49 }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  assert.strictEqual(ctx.groundingMode, 'cold_start');
  assert.strictEqual(ctx.coldStartActive, true);
  assert.strictEqual(ctx.publishedCount, 49);
  assert.ok(ctx.expertCorpus.length > 0);
});

test('S4: count at threshold (count=51, exceeds 50) → switch to warm, corpus OFF', async () => {
  gc._resetCache();
  // countPublishedContent caps at THRESHOLD+1 = 51, which is >= 50 → warm
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 51 }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  assert.strictEqual(ctx.groundingMode, 'warm');
  assert.strictEqual(ctx.coldStartActive, false);
  assert.strictEqual(ctx.expertCorpus.length, 0, 'corpus must be empty in warm mode');
});

test('S4: warm mode + agency plan still gets 0 corpus rows (S4 supersedes S3)', async () => {
  gc._resetCache();
  // Even agency tier, once warm, gets no corpus
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 100, plan: 'agency' }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  assert.strictEqual(ctx.expertCorpus.length, 0);
});

test('S4: empty context (no businessId) reports cold_start defaults', async () => {
  const ctx = await gc.buildGroundingContext({});
  assert.strictEqual(ctx.groundingMode, 'cold_start');
  assert.strictEqual(ctx.publishedCount, 0);
  assert.strictEqual(ctx.coldStartActive, true);
});

test('S4: cacheable blocks reflect cold-start state', async () => {
  gc._resetCache();
  // Cold customer → corpus block exists in cacheable_blocks
  const cold = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 10 }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  const coldBlocks = cold.toCacheableBlocks();
  assert.ok(
    coldBlocks.some((b) => b.cache_control),
    'cold customer must emit cacheable corpus block'
  );

  // Warm customer → no corpus block in cacheable_blocks
  gc._resetCache();
  const warm = await gc.buildGroundingContext({
    sbGet: makeFakeSbGet({ publishedCount: 100 }),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'agency',
  });
  const warmBlocks = warm.toCacheableBlocks();
  assert.ok(!warmBlocks.some((b) => b.cache_control), 'warm customer must NOT emit cacheable corpus block');
});
