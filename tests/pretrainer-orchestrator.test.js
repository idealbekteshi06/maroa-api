'use strict';

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('../services/public-pretrainer/orchestrator');

// Inject fakes via the source modules' module-cache
const metaAdLib = require('../services/public-pretrainer/sources/meta-ad-library');
const placesCohort = require('../services/public-pretrainer/sources/google-places-cohort');

test('runForCohort: requires industryId + regionId', async () => {
  const r = await orchestrator.runForCohort({});
  assert.strictEqual(r.ok, false);
});

test('runForCohort: requires callClaude + sbGet + sbPost', async () => {
  const r = await orchestrator.runForCohort({ industryId: 'cafe', regionId: 'US' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /callClaude/);
});

test('runForCohort: returns ok=false for unknown industry', async () => {
  const r = await orchestrator.runForCohort({
    industryId: 'not_real',
    regionId: 'US',
    deps: { callClaude: async () => '', sbGet: async () => [], sbPost: async () => ({}) },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unknown/);
});

test('runForCohort: end-to-end with stubbed sources', async () => {
  // Stub meta ad library
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  metaAdLib.fetchByPage = async () => ({
    ok: true,
    source: 'meta_ad_library',
    ads: [
      {
        source_ref: 'ad1',
        title: 'Best Coffee',
        body: 'Specifically crafted by 47 baristas — every cup pulled in 21 seconds for full crema',
        cta: 'Try it',
        runtime_days: 180,
        page_name: 'Blue Bottle Coffee',
        region: 'US',
      },
    ],
  });
  metaAdLib.fetchByKeyword = async () => ({ ok: true, source: 'meta_ad_library', ads: [] });
  placesCohort.fetch = async () => ({ ok: true, source: 'google_places_cohort', reviews: [] });

  const inserts = [];
  let runId = 0;
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: `run-${++runId}` }];
    return { ok: true };
  };
  const sbPatch = async () => ({ ok: true });
  const sbGet = async () => []; // never seen before — dedup miss
  const fakeClaude = async (args) => {
    if (args.system?.includes('marketing taxonomist')) {
      return '{"industry":"cafe","format":"meta_ad","language":"en","confidence":0.92}';
    }
    return '';
  };

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet, sbPost, sbPatch, logger: { info: () => {}, warn: () => {} } },
    options: { maxExpertBrands: 1 },
  });

  assert.strictEqual(r.ok, true);
  assert.ok(r.examples_fetched >= 1);
  assert.ok(r.examples_kept >= 1, `expected ≥1 kept, got ${r.examples_kept}`);

  // Verify the inserted corpus row has the right classification
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.ok(corpusInserts.length >= 1);
  const corpusRow = corpusInserts[0].row;
  assert.strictEqual(corpusRow.industry, 'cafe');
  assert.strictEqual(corpusRow.format, 'meta_ad');
  assert.strictEqual(corpusRow.source, 'meta_ad_library');
  assert.ok(corpusRow.quality_score >= 0.3 && corpusRow.quality_score <= 1);
  assert.ok(['high', 'medium', 'low'].includes(corpusRow.outcome_label));

  // Restore
  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('runForCohort: skips already-existing rows (idempotency)', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  metaAdLib.fetchByPage = async () => ({
    ok: true,
    source: 'meta_ad_library',
    ads: [{ source_ref: 'duplicate-ad', body: 'Already in corpus, should be skipped' }],
  });
  metaAdLib.fetchByKeyword = async () => ({ ok: true, ads: [] });
  placesCohort.fetch = async () => ({ ok: true, reviews: [] });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'run-x' }];
    return { ok: true };
  };
  // Pretend the ad already exists
  const sbGet = async () => [{ id: 'existing' }];
  const fakeClaude = async () => '';

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet, sbPost, sbPatch: async () => ({}) },
    options: { maxExpertBrands: 1 },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.examples_kept, 0, 'should not insert duplicates');
  assert.ok(r.examples_skipped >= 1);
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.strictEqual(corpusInserts.length, 0);

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('_aggregateRegionToCountries: maps aggregates to country lists', () => {
  assert.ok(orchestrator._aggregateRegionToCountries('GLOBAL').includes('US'));
  assert.ok(orchestrator._aggregateRegionToCountries('EU').includes('DE'));
  assert.ok(orchestrator._aggregateRegionToCountries('APAC').includes('JP'));
  // Country code passes through
  assert.deepStrictEqual(orchestrator._aggregateRegionToCountries('US'), ['US']);
});

test('runForAll: respects totalCapExamples and stops early', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  metaAdLib.fetchByPage = async () => ({ ok: true, ads: [] });

  const r = await orchestrator.runForAll({
    deps: { callClaude: async () => '', sbGet: async () => [], sbPost: async () => ({}), sbPatch: async () => ({}) },
    options: {
      industries: ['cafe', 'restaurant'],
      regions: ['US'],
      totalCapExamples: 0, // immediate stop
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total_kept, 0);

  metaAdLib.fetchByPage = origFetchByPage;
});
