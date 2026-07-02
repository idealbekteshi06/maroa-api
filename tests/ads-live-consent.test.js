'use strict';

// Per-business ad-execution consent (migration 095): businesses.ads_live=true
// arms real execution for ONE consenting customer while the global env flags
// (META_AD_LAUNCH_LIVE / GOOGLE_ADS_LIVE) stay off as the kill-switch.

const test = require('node:test');
const assert = require('node:assert/strict');

const metaMarketing = require('../services/meta-marketing');
const { register } = require('../routes/onboarding');

test.beforeEach(() => {
  delete process.env.META_AD_LAUNCH_LIVE;
  delete process.env.GOOGLE_ADS_LIVE;
});

test('meta createCampaign: env off + no consent → dry run', async () => {
  const r = await metaMarketing.createCampaign({
    business: { id: 'b1', ad_account_id: 'act1', ads_live: false },
    name: 'X',
    conversionEvent: 'Lead',
    dailyBudgetCents: 1000,
  });
  assert.equal(r.dry_run, true);
  assert.match(r.reason, /ads_live=false/);
});

test('meta createCampaign: env off + business consented → REAL call attempted', async () => {
  // No token on the business row → graphCall fails fast with "access token
  // required", which proves the dry-run gate was passed (no network needed).
  const r = await metaMarketing.createCampaign({
    business: { id: 'b1', ad_account_id: 'act1', ads_live: true },
    name: 'X',
    conversionEvent: 'Lead',
    dailyBudgetCents: 1000,
  });
  assert.notEqual(r.dry_run, true, 'consenting business must not be dry-run gated');
  assert.equal(r.ok, false);
  assert.match(r.reason, /access token required/);
});

test('meta updateCampaignBudget: consent arms execution the same way', async () => {
  const dry = await metaMarketing.updateCampaignBudget({
    business: { id: 'b1', ads_live: false },
    metaCampaignId: 'c1',
    dailyBudgetCents: 500,
  });
  assert.equal(dry.dry_run, true);

  const live = await metaMarketing.updateCampaignBudget({
    business: { id: 'b1', ads_live: true },
    metaCampaignId: 'c1',
    dailyBudgetCents: 500,
  });
  assert.notEqual(live.dry_run, true);
  assert.match(live.reason, /access token required/);
});

test('meta: env flag still overrides for non-consenting business (global arm)', async () => {
  process.env.META_AD_LAUNCH_LIVE = 'true';
  try {
    const r = await metaMarketing.createCampaign({
      business: { id: 'b1', ad_account_id: 'act1' },
      name: 'X',
      conversionEvent: 'Lead',
      dailyBudgetCents: 1000,
    });
    assert.notEqual(r.dry_run, true);
  } finally {
    delete process.env.META_AD_LAUNCH_LIVE;
  }
});

// ─── onboarding: explicit consent answer writes ads_live ───────────────────

function buildFakeApp() {
  const handlers = {};
  return {
    app: {
      post: (path, ...mw) => {
        handlers[`POST ${path}`] = mw[mw.length - 1];
      },
      get: (path, ...mw) => {
        handlers[`GET ${path}`] = mw[mw.length - 1];
      },
      patch: (path, ...mw) => {
        handlers[`PATCH ${path}`] = mw[mw.length - 1];
      },
    },
    handlers,
  };
}

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (x) => {
    res.body = x;
    return res;
  };
  return res;
}

async function runSave(body) {
  const patches = [];
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table) => (table === 'businesses' ? [{ id: 'biz-1', user_id: 'user-1' }] : []),
    sbPost: async (_t, row) => [row],
    sbPatch: async (table, q, patch) => {
      patches.push({ table, q, patch });
      return [];
    },
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
  });
  const res = fakeRes();
  await handlers['POST /api/onboarding/save']({ user: { id: 'user-1', email: 'a@b.c' }, body }, res);
  return { res, bizPatch: patches.find((p) => p.table === 'businesses' && p.patch.onboarding_complete) };
}

test('onboarding save: adsConsent=true writes ads_live=true', async () => {
  const { bizPatch } = await runSave({ business_name: 'X', adsConsent: true });
  assert.equal(bizPatch.patch.ads_live, true);
});

test('onboarding save: adsConsent=false writes ads_live=false explicitly', async () => {
  const { bizPatch } = await runSave({ business_name: 'X', adsConsent: false });
  assert.equal(bizPatch.patch.ads_live, false);
});

test('onboarding save: no consent answer leaves ads_live untouched (safe default)', async () => {
  const { bizPatch } = await runSave({ business_name: 'X' });
  assert.equal('ads_live' in bizPatch.patch, false);
});
