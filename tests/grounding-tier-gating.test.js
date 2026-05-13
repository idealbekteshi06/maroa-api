'use strict';

/**
 * tests/grounding-tier-gating.test.js
 *
 * Wave 59 Session 3 — verifies the plan-based corpus tier gating:
 *   - free   → 0 corpus rows
 *   - growth → up to 2
 *   - agency → up to 5
 *   - unknown plan → safe default (free)
 */

const test = require('node:test');
const assert = require('node:assert');

const gc = require('../lib/groundingContext');

function makeFakeSbGetWithCorpus(rows) {
  return async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'growth' }];
    if (table === 'marketing_corpus') return rows;
    return [];
  };
}

const sampleCorpus = Array.from({ length: 10 }, (_, i) => ({
  id: `mc${i}`,
  title: `Example ${i}`,
  body: `Expert example ${i} with specific 12,847 customer count`,
  industry: 'cafe',
  region: 'US',
  quality_score: 0.95 - i * 0.01,
  source: 'meta_ad_library',
}));

// ─── corpusLimitForPlan ────────────────────────────────────────────────────

test('S3: corpusLimitForPlan returns correct limits per plan', () => {
  assert.strictEqual(gc.corpusLimitForPlan('free'), 0);
  assert.strictEqual(gc.corpusLimitForPlan('growth'), 2);
  assert.strictEqual(gc.corpusLimitForPlan('agency'), 5);
});

test('S3: corpusLimitForPlan is case-insensitive', () => {
  assert.strictEqual(gc.corpusLimitForPlan('FREE'), 0);
  assert.strictEqual(gc.corpusLimitForPlan('Growth'), 2);
  assert.strictEqual(gc.corpusLimitForPlan('AGENCY'), 5);
});

test('S3: corpusLimitForPlan handles whitespace', () => {
  assert.strictEqual(gc.corpusLimitForPlan('  growth  '), 2);
});

test('S3: unknown plan defaults to free (0) — never accidentally enable', () => {
  assert.strictEqual(gc.corpusLimitForPlan('enterprise'), 0);
  assert.strictEqual(gc.corpusLimitForPlan(''), 0);
  assert.strictEqual(gc.corpusLimitForPlan(null), 0);
  assert.strictEqual(gc.corpusLimitForPlan(undefined), 0);
});

test('S3: CORPUS_LIMITS_BY_PLAN is exposed for inspection', () => {
  assert.strictEqual(gc.CORPUS_LIMITS_BY_PLAN.free, 0);
  assert.strictEqual(gc.CORPUS_LIMITS_BY_PLAN.growth, 2);
  assert.strictEqual(gc.CORPUS_LIMITS_BY_PLAN.agency, 5);
});

// ─── fetchExpertCorpus directly ─────────────────────────────────────────

test('S3: fetchExpertCorpus returns [] when plan=free', async () => {
  const rows = await gc.fetchExpertCorpus({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    business: { industry: 'cafe', country: 'US' },
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 3,
    plan: 'free',
  });
  assert.strictEqual(rows.length, 0);
});

test('S3: fetchExpertCorpus returns up to 2 rows when plan=growth', async () => {
  const rows = await gc.fetchExpertCorpus({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    business: { industry: 'cafe', country: 'US' },
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 5, // caller asked for 5
    plan: 'growth', // but plan limits to 2
  });
  assert.strictEqual(rows.length, 2);
});

test('S3: fetchExpertCorpus returns up to 5 rows when plan=agency', async () => {
  const rows = await gc.fetchExpertCorpus({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    business: { industry: 'cafe', country: 'US' },
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 10,
    plan: 'agency',
  });
  assert.strictEqual(rows.length, 5);
});

// ─── buildGroundingContext end-to-end with tier ────────────────────────

test('S3: buildGroundingContext free plan emits 0 corpus rows', async () => {
  gc._resetCache();
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    plan: 'free',
  });
  assert.strictEqual(ctx.expertCorpus.length, 0);
});

test('S3: buildGroundingContext growth plan emits up to 2 corpus rows', async () => {
  gc._resetCache();
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 5,
    plan: 'growth',
  });
  assert.strictEqual(ctx.expertCorpus.length, 2);
});

test('S3: buildGroundingContext agency plan emits up to 5 corpus rows', async () => {
  gc._resetCache();
  const ctx = await gc.buildGroundingContext({
    sbGet: makeFakeSbGetWithCorpus(sampleCorpus),
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 10,
    plan: 'agency',
  });
  assert.strictEqual(ctx.expertCorpus.length, 5);
});

test('S3: buildGroundingContext falls back to business.plan when plan param missing', async () => {
  gc._resetCache();
  // business row has plan='growth' — should be picked up
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'growth' }];
    if (table === 'marketing_corpus') return sampleCorpus;
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 5,
    // no explicit plan param — should use business.plan from DB
  });
  assert.strictEqual(ctx.expertCorpus.length, 2);
});

test('S3: buildGroundingContext defaults to free when business.plan is missing AND no param', async () => {
  gc._resetCache();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US' /* no plan */ }];
    if (table === 'marketing_corpus') return sampleCorpus;
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 5,
  });
  assert.strictEqual(ctx.expertCorpus.length, 0, 'must default to free (0 rows) for safety');
});

test('S3: explicit plan param overrides business.plan', async () => {
  gc._resetCache();
  // business has agency, but caller says free
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'biz1', industry: 'cafe', country: 'US', plan: 'agency' }];
    if (table === 'marketing_corpus') return sampleCorpus;
    return [];
  };
  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz1',
    surface: 'social_post',
    semanticQuery: 'cafe ad',
    limit: 10,
    plan: 'free', // explicit override
  });
  assert.strictEqual(ctx.expertCorpus.length, 0);
});
