'use strict';

/**
 * tests/meta-graph-publish.test.js
 *
 * Validates the Meta Graph live publish path in services/social-multi/index.js
 * — the part that was a stub returning "live publish not yet implemented"
 * before this branch. Uses fake fetch + fakeSupabase so no network is
 * touched.
 */

const test = require('node:test');
const assert = require('node:assert');

const social = require('../services/social-multi');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const BIZ_UUID = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';

// ─── Header parser ──────────────────────────────────────────────────────

test('parseRateLimitHeader: returns null on missing header', () => {
  assert.strictEqual(social.parseRateLimitHeader ? social.parseRateLimitHeader(null) : null, null);
});

test('classifyMetaError: rate-limit code 4 → category=rate_limit + retryable', () => {
  const c = social.classifyMetaError({ error: { code: 4, message: 'too many calls' } });
  assert.strictEqual(c.category, 'rate_limit');
  assert.strictEqual(c.retryable, true);
});

test('classifyMetaError: subcode 1487390 → daily_spend_cap not retryable', () => {
  const c = social.classifyMetaError({ error: { code: 100, error_subcode: 1487390 } });
  assert.strictEqual(c.category, 'daily_spend_cap');
  assert.strictEqual(c.retryable, false);
});

test('classifyMetaError: token expired → token_expired not retryable', () => {
  const c = social.classifyMetaError({ error: { code: 190, message: 'invalid token' } });
  assert.strictEqual(c.category, 'token_expired');
  assert.strictEqual(c.retryable, false);
});

test('classifyMetaError: IG media still uploading → retryable with hint', () => {
  const c = social.classifyMetaError({ error: { code: 9007, error_subcode: 2207001 } });
  assert.strictEqual(c.category, 'ig_media_unavailable');
  assert.strictEqual(c.retryable, true);
});

// ─── Dry-run behavior (default — no META_PUBLISH_LIVE) ──────────────────

test('postNow Meta path: dry-runs without META_PUBLISH_LIVE', async () => {
  const orig = process.env.META_PUBLISH_LIVE;
  delete process.env.META_PUBLISH_LIVE;

  const db = createFakeSupabase();
  db.seed('businesses', [
    {
      id: BIZ_UUID,
      plan: 'growth',
      meta_access_token: 'EAAfake',
      facebook_page_id: 'page-1',
      facebook_page_access_token: 'EAAfake-page',
      instagram_account_id: 'ig-1',
      threads_account_id: 'th-1',
      ayrshare_profile_key: null,
    },
  ]);

  const r = await social.postNow({
    businessId: BIZ_UUID,
    platforms: ['facebook'],
    content: { body: 'hello world' },
    deps: { sbGet: db.sbGet, sbPost: db.sbPost, logger: { info: () => {}, warn: () => {} } },
  });

  process.env.META_PUBLISH_LIVE = orig;
  assert.strictEqual(r.ok, true, 'dry-run returns ok');
  assert.strictEqual(r.dry_run_count, 1, 'one dry-run result');
  assert.strictEqual(r.results[0].via, 'meta_graph');
  assert.strictEqual(r.results[0].dry_run, true);
});

// ─── Live mode with mocked fetch — Facebook + IG + Threads happy paths ─

test('postNow Meta path: Facebook publish with text-only when LIVE=true', async () => {
  const orig = process.env.META_PUBLISH_LIVE;
  process.env.META_PUBLISH_LIVE = 'true';
  const origFetch = global.fetch;
  let lastUrl = '';
  global.fetch = async (url) => {
    lastUrl = url.toString();
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ id: 'fb_post_42', post_id: 'fb_post_42' }),
    };
  };

  const db = createFakeSupabase();
  db.seed('businesses', [
    {
      id: BIZ_UUID,
      plan: 'growth',
      meta_access_token: 'EAA-user',
      facebook_page_id: 'page-1',
      facebook_page_access_token: 'EAA-page',
    },
  ]);

  const r = await social.postNow({
    businessId: BIZ_UUID,
    platforms: ['facebook'],
    content: { body: 'test post' },
    deps: { sbGet: db.sbGet, sbPost: db.sbPost, logger: { info: () => {}, warn: () => {} } },
  });

  process.env.META_PUBLISH_LIVE = orig;
  global.fetch = origFetch;

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.results[0].post_id, 'fb_post_42');
  assert.match(lastUrl, /\/page-1\/feed/);
  assert.match(lastUrl, /access_token=EAA-page/, 'uses page access token, not user token');
});

test('postNow Meta path: Instagram requires media_url, fails fast without', async () => {
  const orig = process.env.META_PUBLISH_LIVE;
  process.env.META_PUBLISH_LIVE = 'true';
  const db = createFakeSupabase();
  db.seed('businesses', [
    {
      id: BIZ_UUID,
      plan: 'growth',
      meta_access_token: 'EAA-user',
      instagram_account_id: 'ig-1',
    },
  ]);

  const r = await social.postNow({
    businessId: BIZ_UUID,
    platforms: ['instagram'],
    content: { body: 'no image attached' },
    deps: { sbGet: db.sbGet, sbPost: db.sbPost, logger: { info: () => {}, warn: () => {} } },
  });
  process.env.META_PUBLISH_LIVE = orig;

  assert.strictEqual(r.results[0].ok, false);
  assert.match(r.results[0].reason, /media_url required/);
});

test('postNow Meta path: rate-limit warning surfaces when worstPct ≥ 75', async () => {
  const orig = process.env.META_PUBLISH_LIVE;
  process.env.META_PUBLISH_LIVE = 'true';
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (k) =>
        k.toLowerCase() === 'x-business-use-case-usage'
          ? JSON.stringify({
              'page-1': [{ type: 'ads_management', call_count: 92, total_cputime: 80, total_time: 60 }],
            })
          : null,
    },
    json: async () => ({ id: 'fb_post_50' }),
  });

  const db = createFakeSupabase();
  db.seed('businesses', [
    {
      id: BIZ_UUID,
      plan: 'growth',
      meta_access_token: 'EAA',
      facebook_page_id: 'page-1',
      facebook_page_access_token: 'EAA-page',
    },
  ]);
  let warnCalled = false;
  const r = await social.postNow({
    businessId: BIZ_UUID,
    platforms: ['facebook'],
    content: { body: 'check rate limit handling' },
    deps: {
      sbGet: db.sbGet,
      sbPost: db.sbPost,
      logger: {
        info: () => {},
        warn: (route, biz, msg, data) => {
          if (msg === 'rate-limit pressure') warnCalled = true;
        },
      },
    },
  });

  process.env.META_PUBLISH_LIVE = orig;
  global.fetch = origFetch;
  assert.strictEqual(r.ok, true);
  assert.ok(warnCalled, 'rate-limit pressure should log warn at 92%');
});
