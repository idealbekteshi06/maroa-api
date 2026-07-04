'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BENCHMARKS, staticBenchmarkRow, SOURCE } = require('../lib/industryBenchmarks');
const fs = require('node:fs');
const path = require('node:path');

test('static benchmarks: every row has sane, complete calibration values', () => {
  const industries = Object.keys(BENCHMARKS);
  assert.ok(industries.length >= 16, 'global + 15 verticals');
  for (const [key, row] of Object.entries(BENCHMARKS)) {
    assert.ok(row.meta_avg_ctr > 0.005 && row.meta_avg_ctr < 0.05, `${key} CTR in plausible band`);
    assert.ok(row.google_avg_cpc_usd > 0.5 && row.google_avg_cpc_usd < 20, `${key} CPC plausible`);
    assert.ok(row.email_open_rate > 0.15 && row.email_open_rate < 0.6, `${key} open rate plausible`);
    assert.ok(row.instagram_engagement_rate > 0.001 && row.instagram_engagement_rate < 0.05, `${key} IG rate`);
    assert.strictEqual(row.best_days_post.length, 3);
    assert.strictEqual(row.best_times_post.length, 3);
    assert.ok(row.benchmarks.meta_cpm_usd > 0);
  }
});

test('staticBenchmarkRow: shaped like an industry_benchmarks table row', () => {
  const row = staticBenchmarkRow('dental');
  assert.strictEqual(row.industry, 'dental');
  assert.strictEqual(row.region, 'GLOBAL');
  assert.strictEqual(row.source, SOURCE);
  assert.ok(Array.isArray(row.top_content_types));
  assert.strictEqual(staticBenchmarkRow('nonexistent_vertical'), null);
});

test('fetchIndustryBenchmarks: falls back to the static table when DB is empty', async () => {
  const { fetchIndustryBenchmarks, formatBenchmarkComparison } = require('../lib/groundingContext');
  const emptyDb = async () => [];
  const bm = await fetchIndustryBenchmarks({ sbGet: emptyDb, industry: 'plumber' });
  assert.ok(bm, 'benchmark returned despite empty DB');
  assert.strictEqual(bm.industry, 'home_services', 'plumber alias resolves to home_services');
  assert.strictEqual(bm.source, SOURCE);

  // The formatter now produces citable lines — the ad-optimizer's anti-slop
  // rule ("never call CTR low without citing the benchmark") is satisfiable.
  const lines = formatBenchmarkComparison(bm, { ctr: 0.008, cpc: 9.5 });
  assert.ok(lines.some((l) => l.includes('industry avg')));
});

test('fetchIndustryBenchmarks: DB row wins over the static table', async () => {
  const { fetchIndustryBenchmarks } = require('../lib/groundingContext');
  const dbRow = { industry: 'dental', region: 'GLOBAL', meta_avg_ctr: 0.02, source: 'live_db' };
  const sbGet = async (_t, filter) => (filter.includes('industry=eq.dental') ? [dbRow] : []);
  const bm = await fetchIndustryBenchmarks({ sbGet, industry: 'dentist' });
  assert.strictEqual(bm.source, 'live_db');
  assert.strictEqual(bm.meta_avg_ctr, 0.02);
});

test('new industry aliases resolve (saas/healthcare/automotive/education/travel)', async () => {
  const { fetchIndustryBenchmarks } = require('../lib/groundingContext');
  const emptyDb = async () => [];
  for (const [alias, expected] of [
    ['software', 'saas'],
    ['veterinary', 'healthcare'],
    ['car dealership', 'automotive'],
    ['tutoring', 'education'],
    ['hotel', 'travel'],
    ['hvac', 'home_services'],
  ]) {
    const bm = await fetchIndustryBenchmarks({ sbGet: emptyDb, industry: alias });
    assert.strictEqual(bm.industry, expected, `${alias} → ${expected}`);
  }
});

test('migration 101 stays in sync with the static table', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '101_seed_industry_benchmarks.sql'), 'utf8');
  for (const [key, row] of Object.entries(BENCHMARKS)) {
    assert.ok(sql.includes(`'${key}'`), `migration seeds ${key}`);
    assert.ok(sql.includes(String(row.google_avg_cpc_usd)), `migration carries ${key} CPC value`);
  }
  assert.strictEqual((sql.match(/INSERT INTO industry_benchmarks/g) || []).length, Object.keys(BENCHMARKS).length);
});
