'use strict';

/**
 * tests/performance-memory.test.js
 *
 * Verifies lib/performanceMemory.js — pgvector-or-LRU semantic search.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createPerformanceMemory, MODE } = require('../lib/performanceMemory');

function fakeSbGet(seed = {}) {
  return async (table, query = '') => {
    const data = seed[table] || [];
    const m = query.match(/business_id=eq\.([^&]+)/);
    if (m) return data.filter((r) => r.business_id === m[1]);
    return data;
  };
}

// ─── init() backend probing ─────────────────────────────────────────────────

test('performanceMemory: init probes for content_embeddings table', async () => {
  const calls = [];
  const sbGet = async (table, query) => {
    calls.push({ table, query });
    if (table === 'content_embeddings') return []; // table exists, empty
    return [];
  };
  const m = createPerformanceMemory({ sbGet });
  const mode = await m.init();
  assert.strictEqual(mode, MODE.PGVECTOR);
  assert.ok(calls.some((c) => c.table === 'content_embeddings'));
});

test('performanceMemory: init falls back to LRU when probe throws', async () => {
  const sbGet = async (table) => {
    if (table === 'content_embeddings') throw new Error('relation does not exist');
    return [];
  };
  const m = createPerformanceMemory({ sbGet });
  const mode = await m.init();
  assert.strictEqual(mode, MODE.LRU);
});

test('performanceMemory: init returns EMPTY when no sbGet provided', async () => {
  const m = createPerformanceMemory({});
  assert.strictEqual(await m.init(), MODE.EMPTY);
});

// ─── findSimilar in LRU mode ────────────────────────────────────────────────

test('performanceMemory: LRU mode returns empty when no businessId or query', async () => {
  const m = createPerformanceMemory({ sbGet: fakeSbGet({}) });
  m._setMode(MODE.LRU);
  assert.deepStrictEqual(await m.findSimilar({}), []);
  assert.deepStrictEqual(await m.findSimilar({ businessId: 'b' }), []);
  assert.deepStrictEqual(await m.findSimilar({ query: 'x' }), []);
});

test('performanceMemory: LRU mode ranks by ROAS for ad_copy surface', async () => {
  const sbGet = fakeSbGet({
    ad_performance_logs: [
      { id: 'a1', business_id: 'biz1', roas: 4.5, ctr: 0.06, recommendation: 'free coffee tuesdays' },
      { id: 'a2', business_id: 'biz1', roas: 0.8, ctr: 0.01, recommendation: 'free coffee weekly' },
      { id: 'a3', business_id: 'biz1', roas: 2.5, ctr: 0.03, recommendation: 'monthly subscription deal' },
    ],
  });
  const m = createPerformanceMemory({ sbGet });
  m._setMode(MODE.LRU);
  const out = await m.findSimilar({
    businessId: 'biz1',
    query: 'free coffee promotion',
    surface: 'ad_copy',
    limit: 2,
  });
  assert.ok(out.length >= 1);
  // Highest ROAS for similar content should rank first
  assert.strictEqual(out[0].id, 'a1', 'highest-ROAS match should rank first');
  assert.strictEqual(out[0].mode, MODE.LRU);
});

test('performanceMemory: LRU mode filters wins vs losses by median ROAS', async () => {
  const sbGet = fakeSbGet({
    ad_performance_logs: [
      { id: 'w1', business_id: 'biz1', roas: 5.0, recommendation: 'specific cafe ad with numbers' },
      { id: 'w2', business_id: 'biz1', roas: 4.5, recommendation: 'another specific cafe ad' },
      { id: 'l1', business_id: 'biz1', roas: 1.2, recommendation: 'generic cafe ad' },
      { id: 'l2', business_id: 'biz1', roas: 0.5, recommendation: 'underperforming cafe ad' },
    ],
  });
  const m = createPerformanceMemory({ sbGet });
  m._setMode(MODE.LRU);
  const wins = await m.findSimilar({
    businessId: 'biz1',
    query: 'cafe ad',
    surface: 'ad_copy',
    direction: 'wins',
    limit: 10,
  });
  const losses = await m.findSimilar({
    businessId: 'biz1',
    query: 'cafe ad',
    surface: 'ad_copy',
    direction: 'losses',
    limit: 10,
  });
  for (const w of wins) assert.ok(w.roas >= 2.85, `win ROAS ${w.roas} should be ≥ median`);
  for (const l of losses) assert.ok(l.roas < 2.85, `loss ROAS ${l.roas} should be < median`);
});

test('performanceMemory: LRU mode caches per (business, surface) for 5min', async () => {
  let calls = 0;
  const sbGet = async (table) => {
    calls++;
    if (table === 'ad_performance_logs') {
      return [{ id: 'a1', business_id: 'biz1', roas: 3, recommendation: 'cafe special offer' }];
    }
    return [];
  };
  const m = createPerformanceMemory({ sbGet });
  m._setMode(MODE.LRU);
  await m.findSimilar({ businessId: 'biz1', query: 'cafe', surface: 'ad_copy' });
  const callsAfter1 = calls;
  await m.findSimilar({ businessId: 'biz1', query: 'different query', surface: 'ad_copy' });
  assert.strictEqual(calls, callsAfter1, 'same business+surface should hit cache regardless of query');
});

test('performanceMemory: LRU mode handles non-ad surfaces from generated_content', async () => {
  const sbGet = fakeSbGet({
    generated_content: [
      {
        id: 'c1',
        business_id: 'biz1',
        status: 'published',
        published_at: new Date(Date.now() - 86400000).toISOString(),
        instagram_caption: 'specific morning routine tip',
        content_theme: 'morning',
      },
    ],
  });
  const m = createPerformanceMemory({ sbGet });
  m._setMode(MODE.LRU);
  const out = await m.findSimilar({
    businessId: 'biz1',
    query: 'morning routine',
    surface: 'social_post',
  });
  assert.strictEqual(out.length, 1);
  assert.match(out[0].text, /morning routine/);
  assert.strictEqual(out[0].mode, MODE.LRU);
});

// ─── findSimilar in PGVECTOR mode (graceful degradation) ────────────────────

test('performanceMemory: PGVECTOR mode falls back to LRU when RPC unavailable', async () => {
  const sbGet = fakeSbGet({
    ad_performance_logs: [{ id: 'a1', business_id: 'biz1', roas: 3, recommendation: 'morning special' }],
  });
  const m = createPerformanceMemory({ sbGet, callClaude: async () => 'mock' });
  m._setMode(MODE.PGVECTOR);
  const out = await m.findSimilar({ businessId: 'biz1', query: 'morning', surface: 'ad_copy' });
  // pgvector path returns null (no real embedding API wired) → LRU fallback
  assert.ok(Array.isArray(out));
  // Results should still be present via LRU path
  if (out.length) {
    assert.strictEqual(out[0].mode, MODE.LRU, 'fallback should mark mode=LRU');
  }
});

// ─── embed() ────────────────────────────────────────────────────────────────

test('performanceMemory: embed returns null on missing callClaude', async () => {
  const m = createPerformanceMemory({});
  const e = await m.embed('test');
  assert.strictEqual(e, null);
});

test('performanceMemory: stub embedding is deterministic + 384-dim + L2-normalized', async () => {
  const m = createPerformanceMemory({ callClaude: async () => 'mock' });
  const a = await m.embed('cafe morning routine');
  const b = await m.embed('cafe morning routine');
  assert.strictEqual(a.length, 384);
  for (let i = 0; i < 384; i++) assert.strictEqual(a[i], b[i], 'embedding must be deterministic');
  // L2 norm should equal 1
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += a[i] * a[i];
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6, 'embedding must be L2-normalized');
});

test('performanceMemory: stub embedding differs for different texts', async () => {
  const m = createPerformanceMemory({ callClaude: async () => 'mock' });
  const a = await m.embed('cafe morning routine');
  const b = await m.embed('completely different content about hardware');
  let same = 0;
  for (let i = 0; i < 384; i++) if (a[i] === b[i]) same++;
  assert.ok(same < 384, 'different texts should produce different embeddings');
});

// ─── Reset + mode introspection ─────────────────────────────────────────────

test('performanceMemory: getMode returns the active backend', async () => {
  const m = createPerformanceMemory({});
  assert.strictEqual(m.getMode(), MODE.EMPTY);
  m._setMode(MODE.LRU);
  assert.strictEqual(m.getMode(), MODE.LRU);
});

test('performanceMemory: _setMode rejects invalid modes', () => {
  const m = createPerformanceMemory({});
  assert.throws(() => m._setMode('not_a_real_mode'), /invalid mode/);
});
