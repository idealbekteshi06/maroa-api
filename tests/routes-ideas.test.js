'use strict';

/**
 * tests/routes-ideas.test.js
 *
 * Verifies routes/ideas.js — generate/list/patch marketing ideas with
 * Claude _raw fallback and idempotency.
 */

const test = require('node:test');
const assert = require('node:assert');

const ideas = require('../routes/ideas');
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
    patch(path, handler) {
      routes[`PATCH ${path}`] = handler;
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

const sampleIdeas = [
  { idea: 'Run a flash sale', category: 'promo', priority: 'high' },
  { idea: 'Email past customers', category: 'email', priority: 'high' },
  { idea: 'Refresh hero image', category: 'creative', priority: 'medium' },
];

const baseDeps = (overrides = {}) => ({
  getProfile: async () => ({
    business_name: 'Test Co',
    business_type: 'cafe',
    primary_language: 'English',
  }),
  callClaude: async () => sampleIdeas,
  pCity: () => 'Tirana',
  claudeBiz: () => ({ businessId: 'biz1' }),
  sbGet: async () => [],
  sbPost: async () => ({}),
  sbPatch: async () => ({}),
  storeInsight: () => {},
  checkOrchestrationIdempotency: async () => false,
  recordOrchestrationTaskRun: async () => {},
  extractJSON: (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  logError: async () => {},
  log: () => {},
  safePublicError: (e) => e.message,
  ...overrides,
});

test('routes/ideas: registers three endpoints', () => {
  const app = makeFakeApp();
  ideas.register({ app, ...baseDeps() });
  assert.ok(app._routes['POST /api/ideas/generate']);
  assert.ok(app._routes['GET /api/ideas/:userId']);
  assert.ok(app._routes['PATCH /api/ideas/:ideaId']);
});

test('routes/ideas: generate returns 400 without userId', async () => {
  const app = makeFakeApp();
  ideas.register({ app, ...baseDeps() });
  const handler = app._routes['POST /api/ideas/generate'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
});

test('routes/ideas: generate inserts all valid ideas + records orchestration', async () => {
  const db = createFakeSupabase();
  const recorded = [];
  const app = makeFakeApp();
  ideas.register({
    app,
    ...baseDeps({
      sbPost: db.sbPost,
      recordOrchestrationTaskRun: async (...args) => recorded.push(args),
    }),
  });
  const handler = app._routes['POST /api/ideas/generate'];
  const res = makeRes();
  await handler({ body: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.received, true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const rows = db.all('marketing_ideas');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].user_id, 'u1');
  assert.deepStrictEqual(recorded[0], ['u1', 'ideas_generate']);
});

test('routes/ideas: generate re-parses _raw fallback', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  ideas.register({
    app,
    ...baseDeps({
      callClaude: async () => ({ _raw: JSON.stringify(sampleIdeas) }),
      sbPost: db.sbPost,
    }),
  });
  const handler = app._routes['POST /api/ideas/generate'];
  await handler({ body: { userId: 'u1' } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(db.all('marketing_ideas').length, 3);
});

test('routes/ideas: generate logs parse failure when result is empty', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  ideas.register({
    app,
    ...baseDeps({
      callClaude: async () => ({}),
      sbPost: db.sbPost,
    }),
  });
  const handler = app._routes['POST /api/ideas/generate'];
  await handler({ body: { userId: 'u1' } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const errors = db.all('errors');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].error_message, /No ideas parsed/);
});

test('routes/ideas: generate skips entries missing idea text', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  ideas.register({
    app,
    ...baseDeps({
      callClaude: async () => [
        { idea: 'good one', priority: 'high' },
        { category: 'orphan', priority: 'low' }, // missing idea field
        { idea: 'another good one', priority: 'medium' },
      ],
      sbPost: db.sbPost,
    }),
  });
  const handler = app._routes['POST /api/ideas/generate'];
  await handler({ body: { userId: 'u1' } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(db.all('marketing_ideas').length, 2, 'orphan entry should be skipped');
});

test('routes/ideas: GET returns recent ideas', async () => {
  const db = createFakeSupabase();
  db.seed('marketing_ideas', [
    { user_id: 'u1', idea: 'a' },
    { user_id: 'u1', idea: 'b' },
  ]);
  const app = makeFakeApp();
  ideas.register({ app, ...baseDeps({ sbGet: db.sbGet }) });
  const handler = app._routes['GET /api/ideas/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.json.ideas.length, 2);
});

test('routes/ideas: PATCH updates idea row', async () => {
  const db = createFakeSupabase();
  db.seed('marketing_ideas', [{ id: 'i1', user_id: 'u1', idea: 'original' }]);
  const app = makeFakeApp();
  ideas.register({ app, ...baseDeps({ sbPatch: db.sbPatch }) });
  const handler = app._routes['PATCH /api/ideas/:ideaId'];
  const res = makeRes();
  await handler({ params: { ideaId: 'i1' }, body: { status: 'done' } }, res);
  assert.strictEqual(res._calls.json.updated, true);
  const updated = db.all('marketing_ideas').find((r) => r.id === 'i1');
  assert.strictEqual(updated.status, 'done');
});
