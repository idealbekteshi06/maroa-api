'use strict';

/**
 * tests/routes-referral.test.js
 *
 * Verifies routes/referral.js — uses fake app + fake supabase to test
 * the actual handler logic without a network stack.
 */

const test = require('node:test');
const assert = require('node:assert');

const referral = require('../routes/referral');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

function makeFakeApp() {
  const routes = {};
  return {
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    },
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    _routes: routes,
  };
}

function makeRes() {
  const calls = { status: null, json: null };
  return {
    status(c) {
      calls.status = c;
      return this;
    },
    json(b) {
      calls.json = b;
      return calls;
    },
    _calls: calls,
  };
}

const baseDeps = (overrides = {}) => ({
  getProfile: async () => ({
    business_name: 'Test Co',
    business_type: 'cafe',
    primary_language: 'English',
  }),
  callClaude: async () => ({
    reward_for_referrer: '€10 credit',
    reward_for_referee: '20%',
  }),
  pCity: () => 'Tirana',
  claudeBiz: () => ({ businessId: 'biz1' }),
  sbGet: async () => [],
  sbPost: async () => ({}),
  storeInsight: () => {},
  log: () => {},
  safePublicError: (e) => e.message,
  ...overrides,
});

test('routes/referral: registers three endpoints', () => {
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps() });
  assert.ok(app._routes['POST /api/referral/setup']);
  assert.ok(app._routes['GET /api/referral/status/:userId']);
  assert.ok(app._routes['POST /api/referral/track']);
});

test('routes/referral: setup returns 400 without userId', async () => {
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps() });
  const handler = app._routes['POST /api/referral/setup'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
  assert.match(res._calls.json.error, /userId/);
});

test('routes/referral: setup acknowledges immediately then generates async', async () => {
  const db = createFakeSupabase();
  const insights = [];
  const app = makeFakeApp();
  referral.register({
    app,
    ...baseDeps({
      sbPost: db.sbPost,
      storeInsight: (...args) => insights.push(args),
    }),
  });
  const handler = app._routes['POST /api/referral/setup'];
  const res = makeRes();
  await handler({ body: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.received, true);
  // give setImmediate a chance to fire
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const inserted = db.all('referral_programs');
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].user_id, 'u1');
  assert.strictEqual(inserted[0].reward_value, '20%');
  assert.strictEqual(inserted[0].is_active, true);
  assert.ok(inserted[0].referral_code.length >= 8, 'referral_code should be 8 hex chars');
  assert.strictEqual(insights.length, 1);
});

test('routes/referral: status returns row when present', async () => {
  const db = createFakeSupabase();
  db.seed('referral_programs', [{ user_id: 'u1', referral_code: 'abc123', is_active: true }]);
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps({ sbGet: db.sbGet }) });
  const handler = app._routes['GET /api/referral/status/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.referral_code, 'abc123');
});

test('routes/referral: status returns inactive when missing', async () => {
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps({ sbGet: async () => [] }) });
  const handler = app._routes['GET /api/referral/status/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'nope' } }, res);
  assert.strictEqual(res._calls.json.active, false);
});

test('routes/referral: track returns 400 without code', async () => {
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps() });
  const handler = app._routes['POST /api/referral/track'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
});

test('routes/referral: track returns 404 for unknown code', async () => {
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps({ sbGet: async () => [] }) });
  const handler = app._routes['POST /api/referral/track'];
  const res = makeRes();
  await handler({ body: { referral_code: 'unknown', referred_email: 'x@y.z' } }, res);
  assert.strictEqual(res._calls.status, 404);
});

test('routes/referral: track inserts referral row for valid code', async () => {
  const db = createFakeSupabase();
  db.seed('referral_programs', [{ user_id: 'u1', referral_code: 'abc123' }]);
  const app = makeFakeApp();
  referral.register({ app, ...baseDeps({ sbGet: db.sbGet, sbPost: db.sbPost }) });
  const handler = app._routes['POST /api/referral/track'];
  const res = makeRes();
  await handler({ body: { referral_code: 'abc123', referred_email: 'new@user.com' } }, res);
  assert.strictEqual(res._calls.json.tracked, true);
  const refs = db.all('referrals');
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].referrer_id, 'u1');
  assert.strictEqual(refs[0].referred_email, 'new@user.com');
  assert.strictEqual(refs[0].status, 'pending');
});
