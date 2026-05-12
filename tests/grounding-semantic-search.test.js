'use strict';

/**
 * tests/grounding-semantic-search.test.js
 *
 * Verifies that lib/groundingContext.buildGroundingContext uses semantic
 * search via performanceMemory when (semanticQuery + performanceMemory)
 * are both provided. Falls back to recency otherwise.
 */

const test = require('node:test');
const assert = require('node:assert');

const gc = require('../lib/groundingContext');

test('grounding: uses performanceMemory.findSimilar when semanticQuery provided', async () => {
  gc._resetCache();
  const calls = [];
  const stubMemory = {
    findSimilar: async (opts) => {
      calls.push(opts);
      if (opts.direction === 'wins') {
        return [{ id: 'w1', text: 'high-ROAS specific morning ad', outcome_score: 4.5, similarity: 0.91 }];
      }
      if (opts.direction === 'losses') {
        return [{ id: 'l1', text: 'low-ROAS generic ad', outcome_score: 0.8, similarity: 0.72 }];
      }
      return [];
    },
  };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    semanticQuery: 'morning coffee promotion',
    performanceMemory: stubMemory,
  });
  // Both wins + losses queries should have fired
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].direction, 'wins');
  assert.strictEqual(calls[1].direction, 'losses');
  assert.strictEqual(calls[0].query, 'morning coffee promotion');
  // The grounding block should contain the semantic-search results
  assert.strictEqual(ctx.wins.length, 1);
  assert.strictEqual(ctx.wins[0].roas, 4.5);
  assert.ok(ctx.wins[0].similarity);
  assert.strictEqual(ctx.losses.length, 1);
  assert.strictEqual(ctx.losses[0].roas, 0.8);
});

test('grounding: falls back to recency when performanceMemory throws', async () => {
  gc._resetCache();
  const sbGet = async (table, query) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    if (table === 'ad_performance_logs' && query.includes('biz1')) {
      return [
        { id: 'recency1', business_id: 'biz1', roas: 3.0, recommendation: 'recency win 1' },
        { id: 'recency2', business_id: 'biz1', roas: 2.5, recommendation: 'recency win 2' },
      ];
    }
    return [];
  };
  const stubMemory = {
    findSimilar: async () => {
      throw new Error('pgvector unavailable');
    },
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    semanticQuery: 'anything',
    performanceMemory: stubMemory,
  });
  // Should have fallen back to recency-based fetchPastPerformance
  assert.ok(ctx.wins.length > 0, 'recency fallback must return wins');
  assert.strictEqual(ctx.wins[0].excerpt.startsWith('recency'), true);
});

test('grounding: skips semantic path when semanticQuery omitted', async () => {
  gc._resetCache();
  let memoryCalled = false;
  const stubMemory = {
    findSimilar: async () => {
      memoryCalled = true;
      return [];
    },
  };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe' }];
    return [];
  };
  await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    performanceMemory: stubMemory,
    // no semanticQuery
  });
  assert.strictEqual(memoryCalled, false, 'semantic path must not fire without a query');
});

test('grounding: skips semantic path when performanceMemory omitted', async () => {
  gc._resetCache();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe' }];
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    semanticQuery: 'query without memory wired',
    // no performanceMemory
  });
  // Just falls back to recency — no crash
  assert.ok(ctx);
});

test('grounding: semantic results render correctly in toPromptBlock', async () => {
  gc._resetCache();
  const stubMemory = {
    findSimilar: async (opts) => {
      if (opts.direction === 'wins') {
        return [
          {
            id: 'w1',
            text: 'Specific 12,847-customer cafe ad with morning hook',
            outcome_score: 5.2,
            similarity: 0.95,
          },
        ];
      }
      return [];
    },
  };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', daily_budget: 30 }];
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'ad_copy',
    semanticQuery: 'morning hook',
    performanceMemory: stubMemory,
  });
  const block = ctx.toPromptBlock();
  assert.match(block, /Past WINS/);
  assert.match(block, /12,847-customer/);
  assert.match(block, /ROAS 5\.2/);
});
