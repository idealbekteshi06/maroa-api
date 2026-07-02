'use strict';

/**
 * tests/paid-ads.test.js — Paid Ads hub routes (Meta / Google / TikTok).
 *
 * node:test with injected fakes (mirrors tests/wf-batch-contract.test.js
 * style): no network, no Supabase — register() gets fake deps and we invoke
 * the captured route handlers directly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const tiktokAds = require('../services/tiktok-ads');

const BIZ_ID = '11111111-1111-4111-8111-111111111111';

function makeApp() {
  const routes = { GET: {}, POST: {} };
  return {
    app: {
      post: (path, ...handlers) => {
        routes.POST[path] = handlers[handlers.length - 1];
      },
      get: (path, ...handlers) => {
        routes.GET[path] = handlers[handlers.length - 1];
      },
    },
    routes,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this._resolve?.(payload);
      return this;
    },
  };
  res.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return res;
}

// server.js apiError shape
function apiError(res, status, code, message, details = null) {
  return res.status(status).json({ error: { code, message, details, timestamp: new Date().toISOString() } });
}

function registerPaidAds(overrides = {}) {
  const { app, routes } = makeApp();
  const posted = [];
  const deps = {
    app,
    sbGet: async () => [],
    sbPost: async (table, row) => {
      posted.push({ table, row });
      return { id: 'camp-1', ...row };
    },
    sbPatch: async () => true,
    callClaude: async () => ({ objective: 'TRAFFIC', ad_groups: [], creatives: [] }),
    apiError,
    log: () => {},
    logError: async () => {},
    tiktokAds,
    env: {},
    ...overrides,
  };
  require('../routes/paid-ads').register(deps);
  return { routes, posted, deps };
}

// ─── tiktok-campaign-create ──────────────────────────────────────────────

test('tiktok-campaign-create: eligible business gets a draft campaign + eligibility', async () => {
  let capturedPrompt = null;
  const { routes, posted } = registerPaidAds({
    sbGet: async (table) => {
      if (table === 'businesses') {
        return [
          {
            id: BIZ_ID,
            business_name: 'Test Biz',
            industry: 'fitness',
            daily_budget: 80,
            tiktok_access_token_enc: 'enc',
            tiktok_business_verified: true,
          },
        ];
      }
      return [];
    },
    callClaude: async (prompt) => {
      capturedPrompt = prompt;
      return { objective: 'LEAD_GENERATION', ad_groups: [], creatives: [] };
    },
  });

  const res = makeRes();
  await routes.POST['/webhook/tiktok-campaign-create'](
    { body: { business_id: BIZ_ID, wizard: { daily_budget: 60, target_audience: 'dog owners in Austin' } } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.eligibility.eligible, true);
  assert.ok(res.body.campaign, 'returns the persisted campaign');

  assert.equal(posted.length, 1);
  const row = posted[0].row;
  assert.equal(posted[0].table, 'ad_campaigns');
  assert.equal(row.platform, 'tiktok');
  assert.equal(row.status, 'draft');
  assert.equal(row.daily_budget, 60, 'wizard budget wins over profile daily_budget');
  assert.equal(row.metadata.dry_run, true, 'never live-launched from this route');
  // Wizard answers are injected into the strategy prompt as hard constraints.
  assert.match(capturedPrompt, /dog owners in Austin/);
  assert.match(capturedPrompt, /\$60\/day/);
});

test('tiktok-campaign-create: under the $50/day floor is rejected before any LLM call', async () => {
  let claudeCalled = false;
  const { routes, posted } = registerPaidAds({
    sbGet: async () => [{ id: BIZ_ID, business_name: 'Tiny Biz', daily_budget: 20, tiktok_business_verified: true }],
    callClaude: async () => {
      claudeCalled = true;
      return {};
    },
  });

  const res = makeRes();
  await routes.POST['/webhook/tiktok-campaign-create']({ body: { business_id: BIZ_ID } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'tiktok_not_eligible');
  assert.equal(res.body.eligibility.eligible, false);
  assert.ok(res.body.eligibility.reasons.length >= 1);
  assert.match(res.body.eligibility.reasons[0], /\$50\/day/);
  assert.equal(claudeCalled, false, 'no Claude budget burned on ineligible businesses');
  assert.equal(posted.length, 0, 'no draft row persisted');
});

test('tiktok-campaign-create: rejects non-UUID business_id', async () => {
  const { routes } = registerPaidAds();
  const res = makeRes();
  await routes.POST['/webhook/tiktok-campaign-create']({ body: { business_id: 'not-a-uuid' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});

// ─── tiktok-campaigns-get ────────────────────────────────────────────────

test('tiktok-campaigns-get: returns { campaigns, summary } and honors metadata.platform', async () => {
  const { routes } = registerPaidAds({
    sbGet: async (table) => {
      assert.equal(table, 'ad_campaigns');
      return [
        { id: 'a', platform: 'tiktok', status: 'active', total_spend: '40', roas: 2 },
        { id: 'b', platform: 'meta', status: 'active', total_spend: '99', roas: 5 },
        { id: 'c', metadata: { platform: 'tiktok' }, status: 'draft', total_spend: '0', roas: 0 },
      ];
    },
  });

  const res = makeRes();
  await routes.GET['/webhook/tiktok-campaigns-get']({ query: { business_id: BIZ_ID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.campaigns.length, 2, 'legacy metadata-only tiktok rows included, meta excluded');
  assert.deepEqual(res.body.summary, {
    total: 2,
    active: 1,
    paused: 0,
    total_spend: '40.00',
    avg_roas: '1.00',
  });
});

// ─── paid-ads-overview ───────────────────────────────────────────────────

test('paid-ads-overview: per-channel connected + stats + eligibility shape', async () => {
  const { routes } = registerPaidAds({
    sbGet: async (table) => {
      if (table === 'businesses') {
        return [
          {
            id: BIZ_ID,
            business_name: 'Hub Biz',
            meta_access_token_enc: 'enc-meta', // connected via _enc column
            ad_account_id: 'act_123',
            // google: nothing set → disconnected
            tiktok_access_token: 'plain-tok', // connected via plaintext column
            tiktok_business_verified: true,
            daily_budget: 100,
            website_url: null,
          },
        ];
      }
      if (table === 'ad_campaigns') {
        return [
          { id: '1', platform: 'meta', status: 'active', total_spend: '120.5', roas: 3 },
          { id: '2', platform: 'meta', status: 'paused', total_spend: '10', roas: 1 },
          { id: '3', platform: 'google', status: 'active', total_spend: '55', roas: 2 },
          { id: '4', metadata: { platform: 'tiktok' }, status: 'draft', total_spend: '0', roas: 0 },
        ];
      }
      return [];
    },
  });

  const res = makeRes();
  await routes.GET['/webhook/paid-ads-overview']({ query: { business_id: BIZ_ID } }, res);

  assert.equal(res.statusCode, 200);
  const { channels } = res.body;
  assert.deepEqual(Object.keys(channels).sort(), ['google', 'meta', 'tiktok']);

  for (const name of ['meta', 'google', 'tiktok']) {
    const ch = channels[name];
    assert.equal(typeof ch.connected, 'boolean', `${name}.connected`);
    assert.equal(typeof ch.campaigns, 'number', `${name}.campaigns`);
    assert.equal(typeof ch.active, 'number', `${name}.active`);
    assert.equal(typeof ch.total_spend, 'string', `${name}.total_spend`);
    assert.equal(typeof ch.avg_roas, 'string', `${name}.avg_roas`);
    assert.equal(typeof ch.eligibility.eligible, 'boolean', `${name}.eligibility.eligible`);
    assert.ok(Array.isArray(ch.eligibility.reasons), `${name}.eligibility.reasons`);
  }

  // meta: _enc token + ad account → connected + eligible
  assert.equal(channels.meta.connected, true);
  assert.equal(channels.meta.eligibility.eligible, true);
  assert.equal(channels.meta.campaigns, 2);
  assert.equal(channels.meta.active, 1);
  assert.equal(channels.meta.total_spend, '130.50');

  // google: no tokens → disconnected + ineligible with reasons
  assert.equal(channels.google.connected, false);
  assert.equal(channels.google.eligibility.eligible, false);
  assert.ok(channels.google.eligibility.reasons.length >= 2);
  assert.equal(channels.google.campaigns, 1);

  // tiktok: plaintext token + $100/day → connected + eligible; draft row counted
  assert.equal(channels.tiktok.connected, true);
  assert.equal(channels.tiktok.eligibility.eligible, true);
  assert.equal(channels.tiktok.campaigns, 1);
  assert.equal(channels.tiktok.active, 0);
});

// ─── meta wizard injection ───────────────────────────────────────────────

test('meta-campaign-create: wizard budget + audience are injected into the strategy prompt', async () => {
  const { app, routes } = makeApp();
  const posted = [];

  let resolvePrompt;
  const promptCaptured = new Promise((r) => {
    resolvePrompt = r;
  });
  let resolvePost;
  const rowPersisted = new Promise((r) => {
    resolvePost = r;
  });

  require('../routes/meta-campaigns').register({
    app,
    sbGet: async (table) => {
      if (table === 'businesses') {
        // No meta token / ad account → draft mode (no Meta API calls).
        return [{ id: BIZ_ID, business_name: 'Wizard Biz', industry: 'cafe', plan: 'growth' }];
      }
      return [];
    },
    sbPost: async (table, row) => {
      posted.push({ table, row });
      if (table === 'ad_campaigns') resolvePost(row);
      return { id: 'mc-1', ...row };
    },
    sbPatch: async () => true,
    callClaude: async (prompt) => {
      resolvePrompt(prompt);
      return { objective: 'OUTCOME_TRAFFIC', daily_budget_usd: 10, creatives: [] };
    },
    apiRequest: async () => ({ status: 200, body: {} }),
    generateImage: async () => ({ url: null, source: 'none' }),
    saveImageToSupabase: async () => null,
    sendEmail: async () => {},
    planGate: () => (req, res, next) => next(),
    actId: (id) => id,
    log: () => {},
    logError: async () => {},
    storeInsight: () => {},
  });

  const res = makeRes();
  await routes.POST['/webhook/meta-campaign-create'](
    {
      body: {
        business_id: BIZ_ID,
        wizard: {
          objective: 'store visits',
          target_audience: 'dog owners in Austin',
          age_range: [25, 44],
          locations: ['Austin, TX'],
          daily_budget: 75,
          duration_days: 14,
          offer: '20% off first grooming',
        },
      },
    },
    res
  );

  assert.equal(res.body.status, 'draft');

  const prompt = await promptCaptured;
  assert.match(prompt, /HARD CONSTRAINTS/, 'wizard block present');
  assert.match(prompt, /\$75\/day \(use EXACTLY this daily budget\)/, 'wizard budget injected');
  assert.match(prompt, /dog owners in Austin/, 'wizard audience injected');
  assert.match(prompt, /25-44/, 'age range injected');
  assert.match(prompt, /Austin, TX/, 'locations injected');
  assert.match(prompt, /20% off first grooming/, 'offer injected');

  const row = await rowPersisted;
  assert.equal(row.daily_budget, 75, 'wizard daily budget used for the campaign budget field');
});

test('meta-campaign-create: absent wizard keeps legacy monthly-derived budget', async () => {
  const { app, routes } = makeApp();

  let resolvePrompt;
  const promptCaptured = new Promise((r) => {
    resolvePrompt = r;
  });
  let resolvePost;
  const rowPersisted = new Promise((r) => {
    resolvePost = r;
  });

  require('../routes/meta-campaigns').register({
    app,
    sbGet: async (table) =>
      table === 'businesses' ? [{ id: BIZ_ID, business_name: 'Legacy Biz', industry: 'cafe', plan: 'growth' }] : [],
    sbPost: async (table, row) => {
      if (table === 'ad_campaigns') resolvePost(row);
      return { id: 'mc-2', ...row };
    },
    sbPatch: async () => true,
    callClaude: async (prompt) => {
      resolvePrompt(prompt);
      return { objective: 'OUTCOME_TRAFFIC', creatives: [] };
    },
    apiRequest: async () => ({ status: 200, body: {} }),
    generateImage: async () => ({ url: null, source: 'none' }),
    saveImageToSupabase: async () => null,
    sendEmail: async () => {},
    planGate: () => (req, res, next) => next(),
    actId: (id) => id,
    log: () => {},
    logError: async () => {},
    storeInsight: () => {},
  });

  const res = makeRes();
  await routes.POST['/webhook/meta-campaign-create']({ body: { business_id: BIZ_ID, monthly_budget: 300 } }, res);

  const prompt = await promptCaptured;
  assert.ok(!/HARD CONSTRAINTS/.test(prompt), 'no wizard block without wizard');
  assert.match(prompt, /\$300\/mo/, 'legacy monthly budget in prompt');

  const row = await rowPersisted;
  assert.equal(row.daily_budget, 10, '300/30 = $10/day legacy derivation unchanged');
});
