'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dataforseo = require('../services/dataforseo');
const metaAdLibrary = require('../services/meta-ad-library');
const metaMarketing = require('../services/meta-marketing');
const googleAdsApi = require('../services/google-ads-api');
const tiktokMarketing = require('../services/tiktok-marketing');

// ─── Configuration probes ────────────────────────────────────────────────

test('dataforseo: isConfigured false without DATAFORSEO_LOGIN/PASSWORD', () => {
  const prev = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  assert.strictEqual(dataforseo.isConfigured(), false);
  if (prev.l !== undefined) process.env.DATAFORSEO_LOGIN = prev.l;
  if (prev.p !== undefined) process.env.DATAFORSEO_PASSWORD = prev.p;
});

test('dataforseo: query returns null when not configured', async () => {
  const prev = { l: process.env.DATAFORSEO_LOGIN, p: process.env.DATAFORSEO_PASSWORD };
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  const r = await dataforseo.query({ prompt: 'best plumber in Austin' });
  assert.strictEqual(r, null);
  if (prev.l !== undefined) process.env.DATAFORSEO_LOGIN = prev.l;
  if (prev.p !== undefined) process.env.DATAFORSEO_PASSWORD = prev.p;
});

test('meta-ad-library: isConfigured false without META_APP_ID/SECRET', () => {
  const prev = { id: process.env.META_APP_ID, sec: process.env.META_APP_SECRET };
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  assert.strictEqual(metaAdLibrary.isConfigured(), false);
  if (prev.id !== undefined) process.env.META_APP_ID = prev.id;
  if (prev.sec !== undefined) process.env.META_APP_SECRET = prev.sec;
});

test('meta-ad-library: search returns [] when not configured', async () => {
  const prev = { id: process.env.META_APP_ID, sec: process.env.META_APP_SECRET };
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const r = await metaAdLibrary.search({ search_terms: 'whatever' });
  assert.deepStrictEqual(r, []);
  if (prev.id !== undefined) process.env.META_APP_ID = prev.id;
  if (prev.sec !== undefined) process.env.META_APP_SECRET = prev.sec;
});

// ─── Meta Marketing — config + dry-run safety ────────────────────────────

test('meta-marketing: isConfigured requires both meta_access_token and ad_account_id', () => {
  assert.strictEqual(metaMarketing.isConfigured({ business: {} }), false);
  assert.strictEqual(metaMarketing.isConfigured({ business: { meta_access_token: 'x' } }), false);
  assert.strictEqual(metaMarketing.isConfigured({ business: { ad_account_id: 'y' } }), false);
  assert.strictEqual(metaMarketing.isConfigured({ business: { meta_access_token: 'x', ad_account_id: 'y' } }), true);
});

test('meta-marketing: createCampaign returns dry_run when META_AD_LAUNCH_LIVE not set', async () => {
  const prev = process.env.META_AD_LAUNCH_LIVE;
  delete process.env.META_AD_LAUNCH_LIVE;
  const r = await metaMarketing.createCampaign({
    business: { meta_access_token: 'x', ad_account_id: 'act_123' },
    name: 'test',
    conversionEvent: 'Lead',
    dailyBudgetCents: 1000,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
  assert.ok(r.campaign_id.startsWith('dry_run_'));
  if (prev !== undefined) process.env.META_AD_LAUNCH_LIVE = prev;
});

test('meta-marketing: createCampaignWithAdSetsAndAds dry-run preserves campaign_id', async () => {
  delete process.env.META_AD_LAUNCH_LIVE;
  const r = await metaMarketing.createCampaignWithAdSetsAndAds({
    business: { meta_access_token: 'x', ad_account_id: 'act_123' },
    payload: {
      name: 'launch_test',
      objective: 'Lead',
      daily_budget: 50,
      variants: [
        { audience_label: 'lookalike', daily_budget: 25, audience: { type: 'lookalike' } },
      ],
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
  assert.ok(r.campaign_id);
  assert.ok(Array.isArray(r.ad_set_ids));
});

test('meta-marketing: META_OBJECTIVE_MAP covers our 6 conversion events', () => {
  for (const ev of ['Lead', 'Purchase', 'Schedule', 'ViewContent', 'CompleteRegistration', 'AddToCart']) {
    assert.ok(metaMarketing.META_OBJECTIVE_MAP[ev], `missing mapping for ${ev}`);
    assert.ok(/OUTCOME_/.test(metaMarketing.META_OBJECTIVE_MAP[ev]));
  }
});

// ─── Google Ads — config + dry-run safety ────────────────────────────────

test('google-ads-api: isConfigured requires dev_token + refresh_token + customer_id', () => {
  const prev = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'devtoken';
  assert.strictEqual(googleAdsApi.isConfigured({}), false);
  assert.strictEqual(googleAdsApi.isConfigured({ google_refresh_token: 'r' }), false);
  assert.strictEqual(googleAdsApi.isConfigured({ google_refresh_token: 'r', google_customer_id: 'c' }), true);
  if (prev === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = prev;
});

test('google-ads-api: createPmaxCampaign returns dry_run without GOOGLE_ADS_LIVE', async () => {
  delete process.env.GOOGLE_ADS_LIVE;
  const r = await googleAdsApi.createPmaxCampaign({
    business: { google_refresh_token: 'r', google_customer_id: '123-456-7890' },
    payload: { name: 'pmax_test', daily_budget: 30 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
});

// ─── TikTok Marketing — config + dry-run safety ──────────────────────────

test('tiktok-marketing: isConfigured requires both fields', () => {
  assert.strictEqual(tiktokMarketing.isConfigured({}), false);
  assert.strictEqual(tiktokMarketing.isConfigured({ tiktok_access_token: 'x' }), false);
  assert.strictEqual(tiktokMarketing.isConfigured({
    tiktok_access_token: 'x', tiktok_advertiser_id: 'y',
  }), true);
});

test('tiktok-marketing: createSmartPlusCampaign dry-run without TIKTOK_ADS_LIVE', async () => {
  delete process.env.TIKTOK_ADS_LIVE;
  const r = await tiktokMarketing.createSmartPlusCampaign({
    business: { tiktok_access_token: 'x', tiktok_advertiser_id: 'y' },
    payload: { name: 'tt_test', daily_budget: 50 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dry_run, true);
});

test('tiktok-marketing: listOrganicPosts returns [] when not configured', async () => {
  const r = await tiktokMarketing.listOrganicPosts({ business: {} });
  assert.deepStrictEqual(r, []);
});

test('tiktok-marketing: fetchInsights returns ok:false reason when not configured', async () => {
  const r = await tiktokMarketing.fetchInsights({ business: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.campaigns?.length || 0, 0);
});
