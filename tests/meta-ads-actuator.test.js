'use strict';

/**
 * tests/meta-ads-actuator.test.js
 * ----------------------------------------------------------------------------
 * Pass 1 of the automated Meta Ads system:
 *   PART 3 — fetchCampaignInsights (real purchase_roas, not the non-existent
 *            `roas` field) + the ad-optimizer pulling fresh insights.
 *   PART 4 — the actuator: ad-optimizer decisions now execute on Meta,
 *            dry-run gated by META_AD_LAUNCH_LIVE.
 *
 * Money-safety is the headline guarantee: with META_AD_LAUNCH_LIVE off,
 * NOTHING is written to Meta.
 *
 * Runner: node --test tests/meta-ads-actuator.test.js
 * ----------------------------------------------------------------------------
 */

const test = require('node:test');
const assert = require('node:assert');

const meta = require('../services/meta-marketing');
const { createFakeClaude, fakeExtractJSON } = require('./helpers/fakeAnthropic');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const BIZ_UUID = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';
const CAMPAIGN_UUID = 'cccc2222-2222-4222-8222-222222222222';
const META_CAMPAIGN_ID = '120200000000000001';

const business = { meta_access_token: 'tok_test', ad_account_id: '1234567890' };

// ─── PART 4: updateCampaign dry-run gating (money safety) ────────────────

test('updateCampaign: dry-run when META_AD_LAUNCH_LIVE off — never calls Meta', async () => {
  const origEnv = process.env.META_AD_LAUNCH_LIVE;
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  delete process.env.META_AD_LAUNCH_LIVE;
  try {
    const r = await meta.updateCampaign({ business, campaignId: META_CAMPAIGN_ID, fields: { status: 'PAUSED' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dry_run, true);
    assert.deepStrictEqual(r.intended, { status: 'PAUSED' });
    assert.strictEqual(fetchCalls, 0, 'must NOT touch Meta in dry-run');
  } finally {
    global.fetch = origFetch;
    if (origEnv === undefined) delete process.env.META_AD_LAUNCH_LIVE;
    else process.env.META_AD_LAUNCH_LIVE = origEnv;
  }
});

test('updateCampaign: rejects empty fields', async () => {
  const r = await meta.updateCampaign({ business, campaignId: META_CAMPAIGN_ID, fields: {} });
  assert.strictEqual(r.ok, false);
});

test('updateCampaign: live mode POSTs to the campaign node', async () => {
  const origEnv = process.env.META_AD_LAUNCH_LIVE;
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, method: init.method, body: init.body };
    return { ok: true, status: 200, json: async () => ({ id: META_CAMPAIGN_ID, success: true }) };
  };
  process.env.META_AD_LAUNCH_LIVE = 'true';
  try {
    const r = await meta.updateCampaign({
      business,
      campaignId: META_CAMPAIGN_ID,
      fields: { daily_budget: 1500 },
    });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.dry_run, 'live call is not a dry-run');
    assert.strictEqual(captured.method, 'POST');
    assert.ok(captured.url.includes(`/${META_CAMPAIGN_ID}?`), 'POSTs to the campaign node');
    assert.ok(captured.body.includes('daily_budget'), 'sends the budget field');
  } finally {
    global.fetch = origFetch;
    if (origEnv === undefined) delete process.env.META_AD_LAUNCH_LIVE;
    else process.env.META_AD_LAUNCH_LIVE = origEnv;
  }
});

// ─── PART 3: fetchCampaignInsights ──────────────────────────────────────

test('fetchCampaignInsights: empty result when Meta not connected', async () => {
  const r = await meta.fetchCampaignInsights({ business: {}, campaignId: META_CAMPAIGN_ID });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.windows, {});
});

test('fetchCampaignInsights: ROAS comes from purchase_roas (not the fake `roas` field)', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        {
          campaign_id: META_CAMPAIGN_ID,
          campaign_name: 'Test',
          spend: '100',
          clicks: '200',
          impressions: '10000',
          ctr: '2',
          cpm: '10',
          frequency: '1.5',
          reach: '8000',
          purchase_roas: [{ action_type: 'omni_purchase', value: '3.5' }],
          actions: [{ action_type: 'purchase', value: '10' }],
          action_values: [{ action_type: 'purchase', value: '350' }],
        },
      ],
    }),
  });
  try {
    const r = await meta.fetchCampaignInsights({
      business,
      campaignId: META_CAMPAIGN_ID,
      datePresets: ['last_7d'],
      withBreakdowns: false,
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.windows.last_7d, 'last_7d window present');
    assert.strictEqual(r.windows.last_7d.roas, 3.5, 'roas read from purchase_roas');
    assert.strictEqual(r.windows.last_7d.conversions, 10);
    assert.strictEqual(r.windows.last_7d.spend, 100);
  } finally {
    global.fetch = origFetch;
  }
});

// ─── Engine actuator wiring ─────────────────────────────────────────────

function seedDb({ decision }) {
  const db = createFakeSupabase();
  db.seed('ad_campaigns', [
    {
      id: CAMPAIGN_UUID,
      business_id: BIZ_UUID,
      meta_campaign_id: META_CAMPAIGN_ID,
      status: 'ACTIVE',
      daily_budget: 10,
      days_active: 21,
      conversions_since_edit: 60,
      days_since_edit: 10,
    },
  ]);
  db.seed('businesses', [
    {
      id: BIZ_UUID,
      business_name: 'Cafe Test',
      industry: 'cafe',
      primary_language: 'en',
      plan: 'growth',
      location: 'Paris',
      meta_access_token: 'tok_test',
      ad_account_id: '1234567890',
    },
  ]);
  db.seed('ad_performance_logs', [
    {
      campaign_id: CAMPAIGN_UUID,
      spend: 60,
      clicks: 200,
      impressions: 12000,
      ctr: 1.6,
      roas: 0.2,
      cpc: 0.3,
      frequency: 1.6,
      reach: 9000,
      conversions: 0,
      logged_at: '2026-05-20T00:00:00Z',
    },
  ]);
  const fakeClaude = createFakeClaude({
    responses: {
      _default: () =>
        JSON.stringify({
          decision,
          decision_reason: 'crafted test decision',
          audit_score: 40,
          score_breakdown: {},
          critical_issues: [],
          warnings: [],
          opportunities: [],
          new_daily_budget: decision === 'pause' ? null : 20,
          trend: 'declining',
          citations: [],
        }),
    },
  });
  return { db, fakeClaude };
}

const EXECUTABLE = new Set(['scale', 'optimize', 'budget_update', 'pause', 'resume']);

test('engine actuator: dryRun never calls Meta', async () => {
  const { db, fakeClaude } = seedDb({ decision: 'pause' });
  const updateCalls = [];
  const metaMarketingClient = {
    fetchCampaignInsights: async ({ campaignId }) => ({
      ok: true,
      campaign_id: campaignId,
      windows: { last_7d: { spend: 60, clicks: 200, impressions: 12000, conversions: 0, roas: 0.2 } },
      breakdowns: {},
    }),
    updateCampaign: async (args) => {
      updateCalls.push(args);
      return { ok: true, raw: { success: true } };
    },
  };

  const adOptimizer = require('../services/ad-optimizer')({
    sbGet: db.sbGet,
    sbPost: db.sbPost,
    sbPatch: db.sbPatch,
    callClaude: fakeClaude,
    extractJSON: fakeExtractJSON,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    Sentry: null,
    metaMarketingClient,
  });

  await adOptimizer.engine.auditOne({ campaignId: CAMPAIGN_UUID, businessId: BIZ_UUID, dryRun: true });
  assert.strictEqual(updateCalls.length, 0, 'dry-run audit must not execute on Meta');
});

test('engine actuator: executable decision pushes to Meta + stamps executed_at', async () => {
  const { db, fakeClaude } = seedDb({ decision: 'pause' });
  const updateCalls = [];
  const metaMarketingClient = {
    fetchCampaignInsights: async ({ campaignId }) => ({
      ok: true,
      campaign_id: campaignId,
      windows: { last_7d: { spend: 60, clicks: 200, impressions: 12000, conversions: 0, roas: 0.2 } },
      breakdowns: {},
    }),
    updateCampaign: async (args) => {
      updateCalls.push(args);
      return { ok: true, raw: { id: META_CAMPAIGN_ID, success: true } };
    },
  };

  const adOptimizer = require('../services/ad-optimizer')({
    sbGet: db.sbGet,
    sbPost: db.sbPost,
    sbPatch: db.sbPatch,
    callClaude: fakeClaude,
    extractJSON: fakeExtractJSON,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    Sentry: null,
    metaMarketingClient,
  });

  const r = await adOptimizer.engine.auditOne({ campaignId: CAMPAIGN_UUID, businessId: BIZ_UUID, dryRun: false });
  const campaign = db.all('ad_campaigns')[0];

  if (EXECUTABLE.has(r.audit.decision)) {
    assert.strictEqual(updateCalls.length, 1, 'actuator fires once for an executable decision');
    assert.strictEqual(updateCalls[0].campaignId, META_CAMPAIGN_ID);
    if (r.audit.decision === 'pause') {
      assert.deepStrictEqual(updateCalls[0].fields, { status: 'PAUSED' });
    }
    assert.ok(campaign.executed_at, 'executed_at stamped on live success');
    assert.ok(campaign.execution_response && campaign.execution_response.ok === true);
  } else {
    assert.strictEqual(updateCalls.length, 0, 'non-executable decision must not call Meta');
  }
});

test('engine actuator: Meta failure is saved to errors and never throws', async () => {
  const { db, fakeClaude } = seedDb({ decision: 'pause' });
  const metaMarketingClient = {
    fetchCampaignInsights: async ({ campaignId }) => ({
      ok: true,
      campaign_id: campaignId,
      windows: { last_7d: { spend: 60, clicks: 200, impressions: 12000, conversions: 0, roas: 0.2 } },
      breakdowns: {},
    }),
    updateCampaign: async () => {
      throw new Error('meta 500 boom');
    },
  };

  const adOptimizer = require('../services/ad-optimizer')({
    sbGet: db.sbGet,
    sbPost: db.sbPost,
    sbPatch: db.sbPatch,
    callClaude: fakeClaude,
    extractJSON: fakeExtractJSON,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    Sentry: null,
    metaMarketingClient,
  });

  const r = await adOptimizer.engine.auditOne({ campaignId: CAMPAIGN_UUID, businessId: BIZ_UUID, dryRun: false });
  assert.ok(r.audit, 'auditOne resolved despite Meta failure');

  if (EXECUTABLE.has(r.audit.decision)) {
    const errors = db.all('errors');
    assert.ok(errors.length >= 1, 'failure recorded in errors table');
    assert.strictEqual(errors[0].workflow_name, 'ad-optimizer-actuator');
  }
});
