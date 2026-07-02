'use strict';

// Onboarding rich-profile persistence — the missing producer side of the
// chain business_profiles → resolveBrandContext → buildBrandContext →
// renderPremiumBrandContext → WF1 strategic prompt. These tests pin the
// full journey: a field the customer types in the wizard must reach the
// content-generation prompt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeOnboardingProfile, computeProfileScore, buildAdProfileContext } = require('../lib/onboardingProfile');
const { register } = require('../routes/onboarding');
const { buildBrandContext } = require('../services/wf1/brandContext');
const { renderPremiumBrandContext } = require('../services/wf1/premiumContextRenderer');

const BIZ_ID = '11111111-1111-4111-8111-111111111111';

const FULL_WIZARD_PAYLOAD = {
  business_name: 'Aqua Prishtina',
  business_type: 'Bottled water delivery',
  business_age: 'growing',
  usp: 'Only glacier-source water delivered same-day in Prishtina',
  tagline: 'Mountain fresh, city fast',
  operation_model: 'mobile',
  primary_language: 'Albanian',
  secondary_languages: ['English', 'Serbian'],
  audience_age_min: 25,
  audience_age_max: 45,
  audience_gender: 'mixed',
  audience_description: 'Health-conscious families and small offices in Prishtina',
  pain_point: 'Tap water tastes bad. Supermarket runs are heavy and annoying',
  avg_spend: '€18/month',
  products: [
    { name: 'Glacier 19L refill', price: '4.50', description: 'Returnable jug' },
    { name: 'Sparkling 6-pack', price: '6.00' },
  ],
  current_offer: 'First month of delivery free',
  primary_goal: 'Double recurring delivery subscriptions in 90 days',
  monthly_budget: '300',
  ads_experience: 'failed',
  tone_keywords: ['warm', 'local', 'trustworthy'],
  never_do: 'cheap, discount water, plastic-shaming',
  business_hours: { mon_fri: '08:00-20:00', sat: '09:00-15:00' },
  seasonal: 'busy_season',
  busy_months: ['June', 'July', 'August'],
  competitors: [
    { name: 'Ujë Rugove', city: 'Prishtina' },
    { name: 'Aqua Viva', city: 'Prishtina' },
  ],
  they_do_better: 'Bigger brand recognition, supermarket shelf space',
  we_do_better: 'Same-day delivery and returnable glass jugs',
};

// ─── sanitizer ─────────────────────────────────────────────────────────────

test('sanitize: full wizard payload survives with correct shapes and key', () => {
  const { row, competitors } = sanitizeOnboardingProfile(FULL_WIZARD_PAYLOAD, BIZ_ID);
  assert.ok(row, 'row should be produced');
  assert.equal(row.user_id, BIZ_ID);
  assert.equal(row.usp, FULL_WIZARD_PAYLOAD.usp);
  assert.equal(row.products.length, 2);
  assert.equal(row.products[0].name, 'Glacier 19L refill');
  assert.equal(row.never_do, 'cheap, discount water, plastic-shaming');
  assert.equal(row.seasonal, 'busy_season');
  assert.deepEqual(row.busy_months, ['June', 'July', 'August']);
  assert.equal(competitors.length, 2);
  assert.equal(competitors[0].name, 'Ujë Rugove');
  assert.ok(row.profile_score >= 90, `rich payload should score high, got ${row.profile_score}`);
});

test('sanitize: invalid enum values are dropped, not fatal', () => {
  const { row } = sanitizeOnboardingProfile(
    { ...FULL_WIZARD_PAYLOAD, seasonal: 'sometimes??', ads_experience: 'expert', operation_model: 'astral' },
    BIZ_ID
  );
  assert.ok(row);
  assert.equal(row.seasonal, undefined);
  assert.equal(row.ads_experience, undefined);
  assert.equal(row.operation_model, undefined);
  // The rest of the payload still survives the bad enums.
  assert.equal(row.usp, FULL_WIZARD_PAYLOAD.usp);
});

test('sanitize: caps hostile payloads (oversized strings, huge arrays)', () => {
  const { row } = sanitizeOnboardingProfile(
    {
      usp: 'x'.repeat(50_000),
      products: Array.from({ length: 200 }, (_, i) => ({ name: `p${i}` })),
      competitors: Array.from({ length: 50 }, (_, i) => ({ name: `c${i}` })),
      tone_keywords: Array.from({ length: 100 }, (_, i) => `k${i}`),
    },
    BIZ_ID
  );
  assert.equal(row.usp.length, 500);
  assert.equal(row.products.length, 20);
  assert.equal(row.competitors.length, 5);
  assert.equal(row.tone_keywords.length, 15);
});

test('sanitize: empty/junk payload produces no row (never overwrite with blanks)', () => {
  const { row, competitors } = sanitizeOnboardingProfile({ irrelevant: 'key', another: 42 }, BIZ_ID);
  assert.equal(row, null);
  assert.deepEqual(competitors, []);
});

test('profile score: empty 0, partial in between', () => {
  assert.equal(computeProfileScore({}), 0);
  const partial = computeProfileScore({ usp: 'x', products: [{ name: 'p' }] });
  assert.ok(partial > 0 && partial < 100);
});

test('buildAdProfileContext: renders specifics, bounded, empty-safe', () => {
  const { row } = sanitizeOnboardingProfile(FULL_WIZARD_PAYLOAD, BIZ_ID);
  const block = buildAdProfileContext(row);
  assert.match(block, /glacier-source water/i);
  assert.match(block, /Glacier 19L refill/);
  assert.match(block, /NEVER use/);
  assert.ok(block.length < 900, `must stay compact, got ${block.length}`);
  assert.equal(buildAdProfileContext(null), '');
  assert.equal(buildAdProfileContext({}), '');
});

// ─── route wiring: /save writes business_profiles + seeds competitors ─────

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

test('POST /api/onboarding/save persists rich profile and seeds businesses.competitors', async () => {
  const writes = { posts: [], patches: [] };
  const db = {
    businesses: [{ id: BIZ_ID, user_id: 'user-1', business_name: 'Aqua Prishtina', plan: 'free' }],
    business_profiles: [],
  };
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table, q) => {
      if (table === 'businesses') return db.businesses;
      if (table === 'business_profiles') return db.business_profiles.filter(() => q.includes(BIZ_ID));
      return [];
    },
    sbPost: async (table, row) => {
      writes.posts.push({ table, row });
      if (table === 'business_profiles') db.business_profiles.push(row);
      return [row];
    },
    sbPatch: async (table, q, patch) => {
      writes.patches.push({ table, q, patch });
      return [];
    },
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
  });

  const res = fakeRes();
  await handlers['POST /api/onboarding/save'](
    { user: { id: 'user-1', email: 'a@b.c' }, body: FULL_WIZARD_PAYLOAD },
    res
  );

  assert.equal(res.body?.ok, true);
  assert.equal(res.body.richProfileSaved, true);
  assert.equal(res.body.competitorsSeeded, 2);

  const profileWrite = writes.posts.find((w) => w.table === 'business_profiles');
  assert.ok(profileWrite, 'business_profiles row must be written');
  assert.equal(profileWrite.row.user_id, BIZ_ID, 'keyed by businessId (the established convention)');
  assert.equal(profileWrite.row.usp, FULL_WIZARD_PAYLOAD.usp);
  assert.equal(profileWrite.row.pain_point, FULL_WIZARD_PAYLOAD.pain_point);

  const competitorPatch = writes.patches.find((w) => w.table === 'businesses' && w.patch.competitors);
  assert.ok(competitorPatch, 'businesses.competitors must be seeded for competitor-watch');
  assert.equal(competitorPatch.patch.competitors[0].name, 'Ujë Rugove');
});

test('save: business_profiles failure is non-fatal and reported honestly', async () => {
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table) => (table === 'businesses' ? [{ id: BIZ_ID, user_id: 'user-1' }] : []),
    sbPost: async (table) => {
      if (table === 'business_profiles') throw new Error('column "products" does not exist');
      return [{}];
    },
    sbPatch: async () => [],
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
  });
  const res = fakeRes();
  await handlers['POST /api/onboarding/save'](
    { user: { id: 'user-1', email: 'a@b.c' }, body: { business_name: 'X', usp: 'something' } },
    res
  );
  assert.equal(res.body?.ok, true, 'save itself must still succeed');
  assert.equal(res.body.richProfileSaved, false, 'and must not claim the profile was saved');
});

// ─── signup → autopilot wiring: autonomy answer, arming flags, cold-start ──

test('save: arms automation on the UPDATE path and honors the autonomy answer', async () => {
  const writes = { patches: [] };
  const coldStarts = [];
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table) => (table === 'businesses' ? [{ id: BIZ_ID, user_id: 'user-1', plan: 'free' }] : []),
    sbPost: async (_table, row) => [row],
    sbPatch: async (table, q, patch) => {
      writes.patches.push({ table, q, patch });
      return [];
    },
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
    triggerColdStart: async (args) => {
      coldStarts.push(args);
    },
  });

  const res = fakeRes();
  await handlers['POST /api/onboarding/save'](
    {
      user: { id: 'user-1', email: 'a@b.c' },
      body: { business_name: 'Aqua Prishtina', autonomyMode: 'full_autopilot', hybridWindowHours: 6 },
    },
    res
  );

  assert.equal(res.body?.ok, true);
  const bizPatch = writes.patches.find((w) => w.table === 'businesses' && w.patch.onboarding_complete);
  assert.ok(bizPatch, 'UPDATE path must write the completion patch');
  assert.equal(bizPatch.patch.autopilot_enabled, true, 'UPDATE path must arm autopilot (old INSERT-only bug)');
  assert.equal(bizPatch.patch.wf1_autonomy_mode, 'full_autopilot', 'autonomy answer must persist');
  assert.equal(bizPatch.patch.wf1_hybrid_window_hours, 6);
  assert.equal(coldStarts.length, 1, 'cold-start must fire on completed onboarding');
  assert.equal(coldStarts[0].businessId, BIZ_ID);
  assert.equal(coldStarts[0].source, 'onboarding_completed');
});

test('save: invalid autonomy answer falls through to the DB default, never errors', async () => {
  const writes = { patches: [] };
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table) => (table === 'businesses' ? [{ id: BIZ_ID, user_id: 'user-1' }] : []),
    sbPost: async (_table, row) => [row],
    sbPatch: async (table, q, patch) => {
      writes.patches.push({ table, q, patch });
      return [];
    },
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
  });
  const res = fakeRes();
  await handlers['POST /api/onboarding/save'](
    { user: { id: 'user-1', email: 'a@b.c' }, body: { business_name: 'X', autonomyMode: 'yolo_mode' } },
    res
  );
  assert.equal(res.body?.ok, true);
  const bizPatch = writes.patches.find((w) => w.table === 'businesses' && w.patch.onboarding_complete);
  assert.ok(bizPatch);
  assert.equal('wf1_autonomy_mode' in bizPatch.patch, false, 'junk mode must not be written');
});

test('save: cold-start trigger failure is non-fatal', async () => {
  const { app, handlers } = buildFakeApp();
  register({
    app,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table) => (table === 'businesses' ? [{ id: BIZ_ID, user_id: 'user-1' }] : []),
    sbPost: async (_table, row) => [row],
    sbPatch: async () => [],
    apiError: (res, code, c, msg) => res.status(code).json({ error: { code: c, message: msg } }),
    safePublicError: (e) => e.message,
    log: () => {},
    triggerColdStart: async () => {
      throw new Error('loopback refused');
    },
  });
  const res = fakeRes();
  await handlers['POST /api/onboarding/save'](
    { user: { id: 'user-1', email: 'a@b.c' }, body: { business_name: 'X' } },
    res
  );
  assert.equal(res.body?.ok, true, 'save must succeed even when the cold-start kick fails');
});

// ─── the proof: a wizard field reaches the content-generation prompt ──────

test('end-to-end: wizard fields reach the WF1 strategic prompt', () => {
  const { row } = sanitizeOnboardingProfile(FULL_WIZARD_PAYLOAD, BIZ_ID);
  // What resolveBrandContext does: businesses row + business_profiles row.
  const ctx = buildBrandContext({
    business: { id: BIZ_ID, business_name: 'Aqua Prishtina', industry: 'Bottled water' },
    profile: row,
  });
  const prompt = renderPremiumBrandContext(ctx);

  assert.match(prompt, /glacier-source water/i, 'USP must reach the prompt');
  assert.match(prompt, /Glacier 19L refill/, 'product names must reach the prompt');
  assert.match(prompt, /Tap water tastes bad/, 'pain points must reach the prompt');
  assert.match(prompt, /Ujë Rugove/, 'named competitors must reach the prompt');
  assert.match(prompt, /Same-day delivery and returnable glass jugs/, 'we-do-better must reach the prompt');
  assert.match(prompt, /discount water/, 'never-use words must reach the prompt as banned words');
  assert.match(prompt, /busy_season|June/, 'seasonality must reach the prompt');
});
