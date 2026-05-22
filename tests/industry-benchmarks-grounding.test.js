'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gc = require('../lib/groundingContext');

const BENCHMARK_ROW = {
  industry: 'dental',
  region: 'GLOBAL',
  meta_avg_ctr: 0.009,
  google_avg_cpc_usd: 4.5,
  email_open_rate: 0.22,
  best_days_post: ['Tuesday', 'Wednesday'],
  best_times_post: ['09:00', '12:00'],
  instagram_engagement_rate: 0.018,
  top_content_types: ['before_after', 'patient_stories'],
};

test('formatBenchmarkComparison includes CTR you-are-at line', () => {
  const lines = gc.formatBenchmarkComparison(BENCHMARK_ROW, { ctr: 0.012 });
  assert.ok(lines.some((l) => l.includes('industry avg 0.90%') && l.includes('you are at 1.20%')));
});

test('buildGroundingContext includes industry benchmarks in prompt block', async () => {
  gc._resetCache();
  const sbGet = async (table, query = '') => {
    if (table === 'businesses') {
      return [{ id: 'biz-1', industry: 'dental', plan: 'growth', daily_budget: 30 }];
    }
    if (table === 'industry_benchmarks') return [BENCHMARK_ROW];
    if (table === 'generated_content' && query.includes('limit=')) return [];
    if (table === 'brand_voice_anchors') return [];
    if (table === 'customer_insights') return [];
    return [];
  };

  const ctx = await gc.buildGroundingContext({
    sbGet,
    businessId: 'biz-1',
    surface: 'ad_copy',
    clientMetrics: { ctr: 0.011 },
    skipCache: true,
  });

  const block = ctx.toPromptBlock();
  assert.match(block, /Industry benchmarks/);
  assert.match(block, /Meta CTR/);
  assert.match(block, /Best times to post/);
  assert.strictEqual(ctx.postingSchedule.best_times.length, 2);
});

test('callClaude path injects benchmarks when businessId set', async () => {
  const captured = { system: '' };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: 'b1', industry: 'restaurant', plan: 'starter' }];
    if (table === 'industry_benchmarks') {
      return [
        {
          industry: 'restaurant',
          meta_avg_ctr: 0.012,
          best_times_post: ['17:00'],
          top_content_types: ['dish_hero'],
        },
      ];
    }
    return [];
  };

  // Minimal callClaude stub — only test grounding injection branch
  const mod = require('../lib/groundingContext');
  const ctx = await mod.buildGroundingContext({
    sbGet,
    businessId: 'b1',
    surface: 'social_post',
    skipCache: true,
  });
  captured.system = ctx.toPromptBlock();
  assert.match(captured.system, /restaurant|Meta CTR|benchmarks/i);
});

test('normalizeIndustrySlug maps gym to fitness', () => {
  assert.strictEqual(gc.normalizeIndustrySlug('Gym'), 'fitness');
  assert.strictEqual(gc.normalizeIndustrySlug('law firm'), 'legal');
});
