'use strict';

/**
 * tests/routes-lead-magnets.test.js
 *
 * Verifies routes/lead-magnets.js — fire-and-forget Claude generation
 * with idempotency guard.
 */

const test = require('node:test');
const assert = require('node:assert');

const leadMagnets = require('../routes/lead-magnets');
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
    audience_description: 'locals',
  }),
  callClaude: async () => ({
    title: 'How to Brew Better Coffee',
    type: 'guide',
    headline: 'Brew like a pro',
    content: 'Step 1...',
  }),
  pCity: () => 'Tirana',
  claudeBiz: () => ({ businessId: 'biz1' }),
  sbGet: async () => [],
  sbPost: async () => ({}),
  storeInsight: () => {},
  checkOrchestrationIdempotency: async () => false,
  recordOrchestrationTaskRun: async () => {},
  log: () => {},
  safePublicError: (e) => e.message,
  ...overrides,
});

test('routes/lead-magnets: registers two endpoints', () => {
  const app = makeFakeApp();
  leadMagnets.register({ app, ...baseDeps() });
  assert.ok(app._routes['POST /api/lead-magnets/generate']);
  assert.ok(app._routes['GET /api/lead-magnets/:userId']);
});

test('routes/lead-magnets: generate returns 400 without userId', async () => {
  const app = makeFakeApp();
  leadMagnets.register({ app, ...baseDeps() });
  const handler = app._routes['POST /api/lead-magnets/generate'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
});

test('routes/lead-magnets: generate acknowledges immediately + inserts row', async () => {
  const db = createFakeSupabase();
  const recorded = [];
  const app = makeFakeApp();
  leadMagnets.register({
    app,
    ...baseDeps({
      sbPost: db.sbPost,
      recordOrchestrationTaskRun: async (...args) => recorded.push(args),
    }),
  });
  const handler = app._routes['POST /api/lead-magnets/generate'];
  const res = makeRes();
  await handler({ body: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.received, true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const rows = db.all('lead_magnets');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].user_id, 'u1');
  assert.strictEqual(rows[0].title, 'How to Brew Better Coffee');
  assert.strictEqual(rows[0].type, 'guide');
  assert.strictEqual(rows[0].is_active, true);
  assert.deepStrictEqual(recorded[0], ['u1', 'lead_magnets_generate']);
});

test('routes/lead-magnets: generate skips when idempotency check returns true', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  leadMagnets.register({
    app,
    ...baseDeps({
      sbPost: db.sbPost,
      checkOrchestrationIdempotency: async () => true,
    }),
  });
  const handler = app._routes['POST /api/lead-magnets/generate'];
  const res = makeRes();
  await handler({ body: { userId: 'u1' } }, res);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(db.all('lead_magnets').length, 0, 'no row inserted on dedup');
});

test('routes/lead-magnets: GET returns recent magnets', async () => {
  const db = createFakeSupabase();
  db.seed('lead_magnets', [
    { user_id: 'u1', title: 'A' },
    { user_id: 'u1', title: 'B' },
  ]);
  const app = makeFakeApp();
  leadMagnets.register({ app, ...baseDeps({ sbGet: db.sbGet }) });
  const handler = app._routes['GET /api/lead-magnets/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.magnets.length, 2);
});

test('routes/lead-magnets: GET returns 500 on DB error', async () => {
  const app = makeFakeApp();
  leadMagnets.register({
    app,
    ...baseDeps({
      sbGet: async () => {
        throw new Error('db down');
      },
    }),
  });
  const handler = app._routes['GET /api/lead-magnets/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.status, 500);
});
