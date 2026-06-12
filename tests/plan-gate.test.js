'use strict';

// planGate unit tests — fast + network-free so the Stryker command runner
// can kill middleware/planGate.js mutants (score was 0.5% with only the
// slow route-level tests exercising it). Runs once per mutant: keep it
// well under 0.5s and never touch the real network.
//
// planGate reads SUPABASE_URL/KEY at require time and calls global fetch,
// so env is pinned BEFORE the require and fetch is stubbed with a recorder.

// Deliberately dirty values: the module strips non-printables and trims —
// asserting the cleaned URL/key below kills the sanitizer mutants.
process.env.SUPABASE_URL = ' https://unit.supabase.test​ ';
process.env.SUPABASE_KEY = ' service-key-123\n';

const test = require('node:test');
const assert = require('node:assert');

const warns = [];
const errors = [];
console.warn = (...a) => warns.push(a.join(' '));
console.error = (...a) => errors.push(a.join(' '));

let fetchCalls = [];
let fetchRows = []; // what the stubbed Supabase responds with
let fetchError = null;
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  if (fetchError) throw fetchError;
  return { json: async () => fetchRows };
};

const planGate = require('../middleware/planGate');

const UUID = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';
const BASE_URL = 'https://unit.supabase.test/rest/v1/businesses?select=plan,user_id&id=eq.';

function makeReq({ body, params, query, headers = {}, user, authSource } = {}) {
  return {
    body,
    params,
    query,
    user,
    authSource,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(x) {
      this.body = x;
      return this;
    },
  };
}

async function run(feature, reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  let nextCalled = false;
  await planGate(feature)(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

function resetStubs({ rows = [], error = null } = {}) {
  fetchCalls = [];
  fetchRows = rows;
  fetchError = error;
}

// ── Feature table is the access-control contract — golden-test it ───────────
test('planGate: FEATURES maps each gated feature to the exact allowed plans', () => {
  assert.deepStrictEqual(planGate.FEATURES, {
    multi_workspace: ['agency'],
    white_label: ['agency'],
    api_access: ['agency'],
    paid_ads: ['growth', 'agency'],
    sms: ['growth', 'agency'],
    competitor_intel: ['growth', 'agency'],
    analytics: ['growth', 'agency'],
    crm: ['growth', 'agency'],
    long_form: ['growth', 'agency'],
    linkedin: ['growth', 'agency'],
    twitter: ['growth', 'agency'],
    tiktok: ['growth', 'agency'],
  });
});

// ── Input validation ─────────────────────────────────────────────────────────
test('planGate: 400 when business_id missing', async () => {
  resetStubs();
  const { res, nextCalled } = await run('paid_ads', { body: {} });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.error, 'business_id required');
  assert.strictEqual(res.body.feature, 'paid_ads');
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(fetchCalls.length, 0);
});

test('planGate: 400 on non-UUID business_id (PostgREST injection guard)', async () => {
  resetStubs();
  const bad = [
    'abc',
    `${UUID}&select=*,plan_history(*)`, // filter breakout attempt
    'fea4aae5-14b4-686d-89f4-33a7d7e4ab60', // version nibble 6 — outside 1-5
    'fea4aae5-14b4-486d-c9f4-33a7d7e4ab60', // variant nibble c — outside 89ab
    'fea4aae5-14b4-486d-89f4-33a7d7e4ab6', // one char short
  ];
  for (const id of bad) {
    const { res, nextCalled } = await run('paid_ads', { body: { business_id: id } });
    assert.strictEqual(res.statusCode, 400, `should reject ${id}`);
    assert.strictEqual(res.body.error, 'business_id must be a valid UUID');
    assert.strictEqual(nextCalled, false);
  }
  assert.strictEqual(fetchCalls.length, 0, 'invalid ids must never reach fetch');
});

test('planGate: uppercase UUID accepted (regex is case-insensitive)', async () => {
  resetStubs({ rows: [{ plan: 'growth', user_id: 'u1' }] });
  const upper = UUID.toUpperCase();
  const { nextCalled } = await run('paid_ads', {
    body: { business_id: upper },
    authSource: 'webhook',
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, BASE_URL + upper);
});

test('planGate: unknown feature fails open without touching Supabase', async () => {
  resetStubs();
  const warnsBefore = warns.length;
  const { nextCalled, res } = await run('brand_new_feature', { body: { business_id: UUID } });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(fetchCalls.length, 0);
  const warned = warns.slice(warnsBefore).join('\n');
  assert.match(warned, /Unknown feature/);
  assert.match(warned, /brand_new_feature/);
});

// ── Plan enforcement (webhook-auth path: trusted caller, no IDOR check) ─────
test('planGate: webhook auth + allowed plan → next, plan attached, sanitized URL/key used', async () => {
  resetStubs({ rows: [{ plan: 'growth', user_id: null }] });
  const { req, nextCalled } = await run('paid_ads', {
    body: { business_id: UUID },
    authSource: 'webhook',
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.business_plan, 'growth');
  assert.strictEqual(req.business_id, UUID);
  assert.strictEqual(fetchCalls.length, 1);
  // URL proves the env sanitizer ran (zero-width char + padding stripped).
  assert.strictEqual(fetchCalls[0].url, BASE_URL + UUID);
  assert.strictEqual(fetchCalls[0].opts.headers.apikey, 'service-key-123');
  // No caller token → falls back to the service key.
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer service-key-123');
});

test('planGate: webhook auth + insufficient plan → 403 upgrade_required', async () => {
  resetStubs({ rows: [{ plan: 'starter', user_id: null }] });
  const { res, nextCalled } = await run('paid_ads', {
    body: { business_id: UUID },
    authSource: 'webhook',
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'upgrade_required');
  assert.strictEqual(res.body.feature, 'paid_ads');
  assert.strictEqual(res.body.current_plan, 'starter');
  assert.deepStrictEqual(res.body.required_plans, ['growth', 'agency']);
  assert.match(res.body.message, /"paid_ads"/);
  assert.match(res.body.message, /growth plan or higher/);
  assert.match(res.body.message, /"starter" plan/);
  assert.strictEqual(res.body.upgrade_url, 'https://maroa-ai-marketing-automator.lovable.app/billing');
});

test('planGate: unknown business row → plan defaults to free → 403', async () => {
  resetStubs({ rows: [] });
  const { res } = await run('paid_ads', { body: { business_id: UUID }, authSource: 'webhook' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.current_plan, 'free');
});

test('planGate: non-array Supabase payload → plan free (optional-chain fallback)', async () => {
  resetStubs({ rows: null });
  const { res } = await run('paid_ads', { body: { business_id: UUID }, authSource: 'webhook' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.current_plan, 'free');
});

// ── IDOR protection (JWT-auth path) ──────────────────────────────────────────
test('planGate: JWT path without req.user → 401 UNAUTHORIZED', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'owner-1' }] });
  const { res, nextCalled } = await run('multi_workspace', { body: { business_id: UUID } });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
  assert.match(res.body.error.message, /JWT required/);
});

test('planGate: JWT path, ownerless business → 403 BUSINESS_NOT_FOUND (fail closed)', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: null }] });
  const { res, nextCalled } = await run('multi_workspace', {
    body: { business_id: UUID },
    user: { id: 'user-1' },
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error.code, 'BUSINESS_NOT_FOUND');
});

test('planGate: JWT path, caller is not the owner → 403 FORBIDDEN + warn', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'owner-1' }] });
  const warnsBefore = warns.length;
  const { res, nextCalled } = await run('multi_workspace', {
    body: { business_id: UUID },
    user: { id: 'attacker-9' },
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error.code, 'FORBIDDEN');
  assert.match(res.body.error.message, /do not own/);
  assert.match(warns.slice(warnsBefore).join('\n'), /IDOR attempt blocked/);
});

test('planGate: JWT path, owner matches → next, caller JWT forwarded to PostgREST', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'owner-1' }] });
  const { nextCalled, req } = await run('multi_workspace', {
    body: { business_id: UUID },
    user: { id: 'owner-1' },
    headers: { authorization: 'Bearer jwt-token-abc' },
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.business_plan, 'agency');
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer jwt-token-abc');
});

test('planGate: lowercase "bearer" header still extracts the token', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'owner-1' }] });
  await run('multi_workspace', {
    body: { business_id: UUID },
    user: { id: 'owner-1' },
    headers: { authorization: 'bearer lower-tok' },
  });
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer lower-tok');
});

test('planGate: no auth header → query token fallback', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'owner-1' }] });
  await run('multi_workspace', {
    body: { business_id: UUID },
    query: { token: 'query-tok' },
    user: { id: 'owner-1' },
  });
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer query-tok');
});

// ── business_id source priority: body > params.business_id > params.id > query ──
test('planGate: business_id source priority chain', async () => {
  const bodyId = '11111111-1111-4111-8111-111111111111';
  const paramsId = '22222222-2222-4222-8222-222222222222';
  const paramsAltId = '33333333-3333-4333-8333-333333333333';
  const queryId = '44444444-4444-4444-8444-444444444444';

  resetStubs({ rows: [{ plan: 'growth', user_id: null }] });
  await run('paid_ads', {
    authSource: 'webhook',
    body: { business_id: bodyId },
    params: { business_id: paramsId, id: paramsAltId },
    query: { business_id: queryId },
  });
  assert.strictEqual(fetchCalls[0].url, BASE_URL + bodyId);

  resetStubs({ rows: [{ plan: 'growth', user_id: null }] });
  await run('paid_ads', {
    authSource: 'webhook',
    params: { business_id: paramsId, id: paramsAltId },
    query: { business_id: queryId },
  });
  assert.strictEqual(fetchCalls[0].url, BASE_URL + paramsId);

  resetStubs({ rows: [{ plan: 'growth', user_id: null }] });
  await run('paid_ads', {
    authSource: 'webhook',
    params: { id: paramsAltId },
    query: { business_id: queryId },
  });
  assert.strictEqual(fetchCalls[0].url, BASE_URL + paramsAltId);

  resetStubs({ rows: [{ plan: 'growth', user_id: null }] });
  await run('paid_ads', { authSource: 'webhook', query: { business_id: queryId } });
  assert.strictEqual(fetchCalls[0].url, BASE_URL + queryId);
});

// ── Failure mode: plan lookup error must DENY paid features ──────────────────
test('planGate: Supabase error → 503 fail-closed', async () => {
  resetStubs({ error: new Error('connect ECONNREFUSED') });
  const errorsBefore = errors.length;
  const { res, nextCalled } = await run('paid_ads', {
    body: { business_id: UUID },
    authSource: 'webhook',
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.match(res.body.error.message, /Unable to verify plan/);
  assert.ok(errors.length > errorsBefore, 'fail-closed path should log the error');
});

// ── planGate.check (inline helper, no req/res context) ───────────────────────
test('planGate.check: returns allowed/plan/required from the live plan', async () => {
  resetStubs({ rows: [{ plan: 'growth', user_id: 'u1' }] });
  const r = await planGate.check(UUID, 'paid_ads');
  assert.deepStrictEqual(r, { allowed: true, plan: 'growth', required: ['growth', 'agency'] });
  // Inline helper has no caller token → service-key auth.
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, 'Bearer service-key-123');

  resetStubs({ rows: [{ plan: 'starter', user_id: 'u1' }] });
  const denied = await planGate.check(UUID, 'multi_workspace');
  assert.deepStrictEqual(denied, { allowed: false, plan: 'starter', required: ['agency'] });
});

test('planGate.check: unknown feature → empty required, not allowed', async () => {
  resetStubs({ rows: [{ plan: 'agency', user_id: 'u1' }] });
  const r = await planGate.check(UUID, 'no_such_feature');
  assert.deepStrictEqual(r, { allowed: false, plan: 'agency', required: [] });
});

test('planGate.check: rejects invalid business_id before any fetch', async () => {
  resetStubs();
  await assert.rejects(() => planGate.check('not-a-uuid', 'paid_ads'), /invalid business_id/);
  assert.strictEqual(fetchCalls.length, 0);
});
