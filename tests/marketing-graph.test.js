'use strict';

/**
 * tests/marketing-graph.test.js
 *
 * Unit tests for lib/marketingGraph.js — verifies the contract against
 * stub deps (no live Supabase).
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeMarketingGraph } = require('../lib/marketingGraph');

function makeFakeSb() {
  const writes = [];
  const patches = [];
  const tables = new Map();

  function sbGet(table, filter) {
    // Simulate the "is table reachable" health probe
    if (filter === 'select=id&limit=1' && tables.get(table) !== false) return Promise.resolve([]);
    if (tables.get(table) === false) return Promise.reject(new Error('relation does not exist'));

    // Return rows the test stored
    const rows = tables.get(table) || [];
    return Promise.resolve(rows);
  }

  function sbPost(table, row, opts = {}) {
    const inserted = { id: `row-${writes.length + 1}`, ...row, created_at: new Date().toISOString() };
    writes.push({ table, row });
    const arr = tables.get(table) || [];
    arr.push(inserted);
    tables.set(table, arr);
    return Promise.resolve(opts.returning === 'representation' ? [inserted] : inserted);
  }

  function sbPatch(table, filter, updates, opts = {}) {
    patches.push({ table, filter, updates });
    const updated = { id: 'patched', ...updates };
    return Promise.resolve(opts.returning === 'representation' ? [updated] : updated);
  }

  function preload(table, rows) {
    tables.set(table, rows);
  }
  function markOffline(table) {
    tables.set(table, false);
  }

  return { sbGet, sbPost, sbPatch, writes, patches, preload, markOffline };
}

// ─── isHealthy ────────────────────────────────────────────────────────────

test('marketingGraph: isHealthy returns true when entities table exists', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  assert.strictEqual(await g.isHealthy(), true);
});

test('marketingGraph: isHealthy returns false + caches when table missing', async () => {
  const sb = makeFakeSb();
  sb.markOffline('marketing_graph_entities');
  const g = makeMarketingGraph(sb);
  assert.strictEqual(await g.isHealthy(), false);
  assert.strictEqual(await g.isHealthy(), false); // cached, not re-probed
});

// ─── Entities ─────────────────────────────────────────────────────────────

test('upsertEntity: requires businessId, type, title', () => {
  const g = makeMarketingGraph(makeFakeSb());
  assert.rejects(() => g.upsertEntity({ type: 'x', title: 'y' }), /required/i);
  assert.rejects(() => g.upsertEntity({ businessId: 'b', title: 'y' }), /required/i);
  assert.rejects(() => g.upsertEntity({ businessId: 'b', type: 'x' }), /required/i);
});

test('upsertEntity: writes a new entity with sensible defaults', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.upsertEntity({
    businessId: 'b1',
    type: 'product',
    title: 'Espresso',
  });
  assert.ok(r.id);
  assert.strictEqual(r.entity_type, 'product');
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(sb.writes.length, 1);
  assert.strictEqual(sb.writes[0].table, 'marketing_graph_entities');
});

test('upsertEntity: dedupes by externalId when supplied (patches instead of inserts)', async () => {
  const sb = makeFakeSb();
  sb.preload('marketing_graph_entities', [
    { id: 'existing-1', business_id: 'b1', entity_type: 'channel', external_id: 'meta-ad-123' },
  ]);
  const g = makeMarketingGraph(sb);
  await g.upsertEntity({
    businessId: 'b1',
    type: 'channel',
    title: 'Meta ad set 123',
    externalId: 'meta-ad-123',
    attrs: { spend: 100 },
  });
  assert.strictEqual(sb.writes.length, 0, 'should not insert');
  assert.strictEqual(sb.patches.length, 1, 'should patch existing');
});

test('upsertEntity: returns null when graph table is missing', async () => {
  const sb = makeFakeSb();
  sb.markOffline('marketing_graph_entities');
  const g = makeMarketingGraph(sb);
  assert.strictEqual(
    await g.upsertEntity({ businessId: 'b1', type: 'product', title: 'X' }),
    null
  );
});

// ─── Edges ───────────────────────────────────────────────────────────────

test('linkEntities: writes an edge', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.linkEntities({
    businessId: 'b1',
    sourceId: 's',
    targetId: 't',
    type: 'used_in',
    weight: 0.7,
  });
  assert.ok(r.id);
  assert.strictEqual(r.edge_type, 'used_in');
  assert.strictEqual(r.weight, 0.7);
});

test('linkEntities: default weight is 1.0', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.linkEntities({ businessId: 'b1', sourceId: 's', targetId: 't', type: 'attributed_to' });
  assert.strictEqual(r.weight, 1.0);
});

// ─── getEntitiesByType ───────────────────────────────────────────────────

test('getEntitiesByType: returns empty when no businessId', async () => {
  const g = makeMarketingGraph(makeFakeSb());
  assert.deepStrictEqual(await g.getEntitiesByType({ type: 'product' }), []);
});

// ─── Claims library ──────────────────────────────────────────────────────

test('recordClaim: writes a new claim', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.recordClaim({
    businessId: 'b1',
    claimText: '30-day money-back guarantee',
    claimType: 'guarantee',
  });
  assert.ok(r.id);
  assert.strictEqual(r.claim_text, '30-day money-back guarantee');
  assert.strictEqual(r.usage_count, 1);
});

test('recordClaim: dedupes existing claim and patches usage_count', async () => {
  const sb = makeFakeSb();
  // Pre-set the dedupe lookup AND the health probe return values.
  sb.sbGet = async (table, filter) => {
    if (filter === 'select=id&limit=1') return [];
    if (table === 'claims_library' && filter.includes('claim_text=eq.')) {
      return [{ id: 'existing-claim' }];
    }
    return [];
  };
  const g = makeMarketingGraph(sb);
  await g.recordClaim({
    businessId: 'b1',
    claimText: 'fastest delivery in Tirana',
  });
  assert.strictEqual(sb.writes.length, 0);
  assert.strictEqual(sb.patches.length, 1);
});

test('pickTopClaims: returns rows ordered (sb-side) by outcome_signal', async () => {
  const sb = makeFakeSb();
  sb.preload('claims_library', [
    { id: 'c1', outcome_signal: 0.9 },
    { id: 'c2', outcome_signal: 0.5 },
  ]);
  const g = makeMarketingGraph(sb);
  const r = await g.pickTopClaims({ businessId: 'b1', limit: 5 });
  assert.strictEqual(r.length, 2);
});

// ─── Offers ──────────────────────────────────────────────────────────────

test('recordOffer: validates offerType', () => {
  const g = makeMarketingGraph(makeFakeSb());
  assert.rejects(() => g.recordOffer({ businessId: 'b1', name: 'X' }), /required/);
});

test('recordOffer: writes a row', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.recordOffer({
    businessId: 'b1',
    name: 'BFCM 20',
    offerType: 'discount_pct',
    offerValue: 20,
    channels: ['email-promo', 'meta-ads-image'],
  });
  assert.strictEqual(r.offer_type, 'discount_pct');
  assert.deepStrictEqual(r.channels, ['email-promo', 'meta-ads-image']);
});

// ─── Creative assets ─────────────────────────────────────────────────────

test('recordCreative: stores Creative Genome decomposition', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.recordCreative({
    businessId: 'b1',
    assetType: 'image',
    channel: 'meta-ads-image',
    genome: {
      hookType: 'fear_relief',
      angle: 'problem_aware',
      emotion: 'relief',
      visualStyle: 'clean_minimal',
      cta: 'Book today',
    },
    claimIds: ['claim-1', 'claim-2'],
  });
  assert.strictEqual(r.hook_type, 'fear_relief');
  assert.strictEqual(r.visual_style, 'clean_minimal');
  assert.deepStrictEqual(r.claim_ids, ['claim-1', 'claim-2']);
});

test('updateCreativePerformance: computes performance_score from ROAS', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  await g.updateCreativePerformance({
    id: 'creative-1',
    impressions: 10000,
    clicks: 400,
    conversions: 20,
    spendUsd: 100,
    revenueUsd: 500,        // ROAS = 5 → score 1.0
  });
  const patch = sb.patches[0];
  assert.strictEqual(patch.updates.performance_score, 1);
});

test('updateCreativePerformance: falls back to CTR when no spend data', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  await g.updateCreativePerformance({
    id: 'creative-2',
    impressions: 10000,
    clicks: 500,             // 5% CTR → score 1.0
    conversions: 0,
    spendUsd: 0,
    revenueUsd: 0,
  });
  const patch = sb.patches[0];
  assert.strictEqual(patch.updates.performance_score, 1);
});

test('updateCreativePerformance: clamps performance to [0,1]', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  await g.updateCreativePerformance({
    id: 'creative-3',
    impressions: 1000,
    clicks: 100,
    conversions: 5,
    spendUsd: 50,
    revenueUsd: 1000,        // ROAS = 20 → clamped to 1
  });
  const patch = sb.patches[0];
  assert.strictEqual(patch.updates.performance_score, 1);
});

// ─── Experiments ─────────────────────────────────────────────────────────

test('recordExperiment: validates variantCount in [2,10]', () => {
  const g = makeMarketingGraph(makeFakeSb());
  assert.rejects(() => g.recordExperiment({ businessId: 'b1', name: 'X', variantCount: 1 }), /2\.\.10/);
  assert.rejects(() => g.recordExperiment({ businessId: 'b1', name: 'X', variantCount: 11 }), /2\.\.10/);
});

test('recordExperiment: writes a planning-status experiment', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  const r = await g.recordExperiment({
    businessId: 'b1',
    name: 'Hook A/B',
    hypothesis: 'fear-relief beats curiosity for dentists',
    variantCount: 3,
    primaryMetric: 'ctr',
    budgetUsd: 50,
  });
  assert.strictEqual(r.status, 'planning');
  assert.strictEqual(r.variant_count, 3);
});

test('completeExperiment: writes winner + lift + conclusion', async () => {
  const sb = makeFakeSb();
  const g = makeMarketingGraph(sb);
  await g.completeExperiment({
    id: 'exp-1',
    winnerCreativeId: 'creative-A',
    confidenceScore: 0.95,
    liftPct: 23.5,
    conclusion: 'Variant A wins',
    spendUsd: 48.30,
  });
  const patch = sb.patches[0];
  assert.strictEqual(patch.updates.status, 'completed');
  assert.strictEqual(patch.updates.winner_creative_id, 'creative-A');
  assert.strictEqual(patch.updates.lift_pct, 23.5);
});

// ─── Defensive ───────────────────────────────────────────────────────────

test('marketingGraph: missing sbGet/sbPost throws at make()', () => {
  assert.throws(() => makeMarketingGraph({}), /required deps/);
});
