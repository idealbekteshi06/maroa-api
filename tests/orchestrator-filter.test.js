'use strict';

/**
 * tests/orchestrator-filter.test.js
 *
 * Wave 59 Session 1 — verifies the eligibility gate that drops ads before
 * they reach the classifier:
 *   - non-expert brand → dropped
 *   - runtime < 60 days → dropped
 *   - sub-threshold quality score → dropped post-scoring
 */

const test = require('node:test');
const assert = require('node:assert');

const orchestrator = require('../services/public-pretrainer/orchestrator');
const metaAdLib = require('../services/public-pretrainer/sources/meta-ad-library');
const placesCohort = require('../services/public-pretrainer/sources/google-places-cohort');

test('orchestrator S1: drops ads from non-expert brands (keyword pass)', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  // Expert-brand pass returns nothing (forces fall through to keyword pass)
  metaAdLib.fetchByPage = async () => ({ ok: true, ads: [] });
  // Keyword pass returns ads from RANDOM small brands — these should be dropped
  metaAdLib.fetchByKeyword = async () => ({
    ok: true,
    ads: [
      {
        source_ref: 'random-1',
        body: 'Some ad from a random local shop',
        page_name: 'Random Local Shop',
        runtime_days: 200, // long runtime, but brand not expert
      },
      {
        source_ref: 'random-2',
        body: 'Another ad',
        page_name: 'Tiny Café Unknown',
        runtime_days: 150,
      },
    ],
  });
  placesCohort.fetch = async () => ({ ok: true, reviews: [] });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'r1' }];
    return { ok: true };
  };
  const sbGet = async () => [];
  const fakeClaude = async () => '';

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet, sbPost, sbPatch: async () => ({}) },
    options: { maxExpertBrands: 0 }, // skip expert-brand pass entirely
  });

  assert.strictEqual(r.ok, true);
  // Both ads should be filtered out by eligibility gate (non-expert brand)
  assert.strictEqual(r.examples_kept, 0, 'non-expert brands must not pass the gate');
  assert.ok(r.examples_skipped >= 2);
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.strictEqual(corpusInserts.length, 0);

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('orchestrator S1: drops ads with runtime < 60 days even from expert brands', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  // Return an ad from an expert brand (Blue Bottle Coffee is in EXPERT_BRANDS.cafe)
  // but with short runtime — should be dropped
  metaAdLib.fetchByPage = async () => ({
    ok: true,
    ads: [
      {
        source_ref: 'fresh-1',
        body: 'A fresh new campaign just launched yesterday',
        page_name: 'Blue Bottle Coffee',
        runtime_days: 5, // too short to be proven
      },
    ],
  });
  metaAdLib.fetchByKeyword = async () => ({ ok: true, ads: [] });
  placesCohort.fetch = async () => ({ ok: true, reviews: [] });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'r2' }];
    return { ok: true };
  };
  const sbGet = async () => [];

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: async () => '', sbGet, sbPost, sbPatch: async () => ({}) },
    options: { maxExpertBrands: 1 },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.examples_kept, 0, 'short-runtime ad must be dropped');
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.strictEqual(corpusInserts.length, 0);

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('orchestrator S1: accepts ads from expert brands with runtime ≥ 60', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  metaAdLib.fetchByPage = async () => ({
    ok: true,
    ads: [
      {
        source_ref: 'proven-1',
        body: 'Proven cafe ad with 90-day runtime — specifically running for 12,847 customers',
        page_name: 'Blue Bottle Coffee',
        runtime_days: 90,
      },
    ],
  });
  metaAdLib.fetchByKeyword = async () => ({ ok: true, ads: [] });
  placesCohort.fetch = async () => ({ ok: true, reviews: [] });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'r3' }];
    return { ok: true };
  };
  const sbGet = async () => [];
  const fakeClaude = async () => '{"industry":"cafe","format":"meta_ad","confidence":0.9}';

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet, sbPost, sbPatch: async () => ({}) },
    options: { maxExpertBrands: 1 },
  });

  assert.strictEqual(r.examples_kept, 1, 'expert brand + long runtime should pass');
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.strictEqual(corpusInserts.length, 1);
  // Quality should be ≥ LONG_RUNTIME_FLOOR
  assert.ok(corpusInserts[0].row.quality_score >= 0.8);

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('orchestrator S1: award winners pass even without industry-specific expert listing', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  // No expert brand pass; only keyword pass returning an award-winner ad
  // from a different industry vertical than 'cafe' (e.g. Liquid Death).
  // Stub increments source_ref per call so the orchestrator's multi-keyword
  // sweep doesn't produce duplicates that all dedup-collide.
  let keywordCallIdx = 0;
  metaAdLib.fetchByPage = async () => ({ ok: true, ads: [] });
  metaAdLib.fetchByKeyword = async () => {
    keywordCallIdx++;
    return {
      ok: true,
      ads: [
        {
          source_ref: `aw-${keywordCallIdx}`,
          body: 'Murder your thirst — Liquid Death campaign',
          page_name: 'Liquid Death',
          runtime_days: 120,
        },
      ],
    };
  };
  placesCohort.fetch = async () => ({ ok: true, reviews: [] });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'r4' }];
    return { ok: true };
  };
  const fakeClaude = async () => '{"industry":"cafe","format":"meta_ad","confidence":0.7}';

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet: async () => [], sbPost, sbPatch: async () => ({}) },
    options: { maxExpertBrands: 0 }, // skip brand pass, force keyword path
  });

  assert.ok(r.examples_kept >= 1, 'award winner should pass even cross-industry');
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.ok(corpusInserts.length >= 1);
  assert.ok(corpusInserts[0].row.quality_score >= 0.95, 'award winners get AWARD_TIER_SCORE');

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});

test('orchestrator S1: sub-threshold quality dropped after scoring (Places reviews)', async () => {
  const origFetchByPage = metaAdLib.fetchByPage;
  const origFetchByKeyword = metaAdLib.fetchByKeyword;
  const origFetchPlaces = placesCohort.fetch;

  metaAdLib.fetchByPage = async () => ({ ok: true, ads: [] });
  metaAdLib.fetchByKeyword = async () => ({ ok: true, ads: [] });
  // Places reviews skip the brand gate (different format) but still go through
  // the post-scoring quality floor. A bad review should be dropped.
  placesCohort.fetch = async () => ({
    ok: true,
    reviews: [
      {
        source_ref: 'rev-bad',
        body: 'meh', // very short, no specificity
        rating: 1,
      },
    ],
  });

  const inserts = [];
  const sbPost = async (table, row) => {
    inserts.push({ table, row });
    if (table === 'pretrainer_runs') return [{ id: 'r5' }];
    return { ok: true };
  };
  const fakeClaude = async () => '{"industry":"cafe","format":"review","confidence":0.7}';

  const r = await orchestrator.runForCohort({
    industryId: 'cafe',
    regionId: 'US',
    deps: { callClaude: fakeClaude, sbGet: async () => [], sbPost, sbPatch: async () => ({}) },
  });

  // Should be dropped at the quality floor check (mediocre body, low rating)
  const corpusInserts = inserts.filter((i) => i.table === 'marketing_corpus');
  assert.strictEqual(corpusInserts.length, 0);

  metaAdLib.fetchByPage = origFetchByPage;
  metaAdLib.fetchByKeyword = origFetchByKeyword;
  placesCohort.fetch = origFetchPlaces;
});
