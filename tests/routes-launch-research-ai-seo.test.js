'use strict';

/**
 * tests/routes-launch-research-ai-seo.test.js
 *
 * Verifies the three small fire-and-forget Claude-orchestrator route
 * modules carved from server.js: launch, research, ai-seo.
 */

const test = require('node:test');
const assert = require('node:assert');

const launch = require('../routes/launch');
const research = require('../routes/research');
const aiSeo = require('../routes/ai-seo');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

function makeFakeApp() {
  const routes = {};
  return {
    post(p, h) {
      routes[`POST ${p}`] = h;
    },
    get(p, h) {
      routes[`GET ${p}`] = h;
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

const sharedDeps = (overrides = {}) => ({
  getProfile: async () => ({
    business_name: 'Test Co',
    business_type: 'cafe',
    primary_language: 'English',
    monthly_budget: '$1000',
    audience_description: 'locals',
    usp: 'best espresso',
  }),
  callClaude: async () => ({ ok: true }),
  pCity: () => 'Tirana',
  claudeBiz: () => ({ businessId: 'biz1' }),
  sbGet: async () => [],
  sbPost: async () => ({}),
  storeInsight: () => {},
  log: () => {},
  safePublicError: (e) => e.message,
  ...overrides,
});

// ─── launch ─────────────────────────────────────────────────────────────────

test('routes/launch: registers two endpoints', () => {
  const app = makeFakeApp();
  launch.register({ app, ...sharedDeps() });
  assert.ok(app._routes['POST /api/launch/create']);
  assert.ok(app._routes['GET /api/launch/:userId']);
});

test('routes/launch: create returns 400 without userId or productName', async () => {
  const app = makeFakeApp();
  launch.register({ app, ...sharedDeps() });
  const handler = app._routes['POST /api/launch/create'];
  const res1 = makeRes();
  await handler({ body: { productName: 'X' } }, res1);
  assert.strictEqual(res1._calls.status, 400);
  const res2 = makeRes();
  await handler({ body: { userId: 'u1' } }, res2);
  assert.strictEqual(res2._calls.status, 400);
});

test('routes/launch: create inserts campaign with default 14-day launch date', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  launch.register({ app, ...sharedDeps({ sbPost: db.sbPost }) });
  const handler = app._routes['POST /api/launch/create'];
  const before = Date.now();
  await handler({ body: { userId: 'u1', productName: 'Widget' } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const rows = db.all('launch_campaigns');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].product_name, 'Widget');
  assert.strictEqual(rows[0].phase, 'pre_launch');
  const launchTs = new Date(rows[0].launch_date).getTime();
  const fourteenDays = 14 * 86400000;
  assert.ok(launchTs - before >= fourteenDays - 1000, 'launch date should default to ~14 days out');
  assert.ok(launchTs - before <= fourteenDays + 5000);
});

test('routes/launch: GET returns 500 on db error', async () => {
  const app = makeFakeApp();
  launch.register({
    app,
    ...sharedDeps({
      sbGet: async () => {
        throw new Error('db gone');
      },
    }),
  });
  const handler = app._routes['GET /api/launch/:userId'];
  const res = makeRes();
  await handler({ params: { userId: 'u1' } }, res);
  assert.strictEqual(res._calls.status, 500);
});

// ─── research ───────────────────────────────────────────────────────────────

test('routes/research: registers one endpoint', () => {
  const app = makeFakeApp();
  research.register({ app, ...sharedDeps() });
  assert.ok(app._routes['POST /api/research/analyze']);
});

test('routes/research: returns 400 without userId', async () => {
  const app = makeFakeApp();
  research.register({ app, ...sharedDeps() });
  const handler = app._routes['POST /api/research/analyze'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
});

test('routes/research: stores customer insight with source=reviews when reviews given', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  research.register({
    app,
    ...sharedDeps({
      callClaude: async () => ({
        pain_points: ['too expensive', 'slow service', 'cold coffee'],
        key_phrases: ['quick fix', 'reliable'],
        trigger_events: ['hangover', 'before work', 'meeting'],
        content_recommendations: ['post about speed', 'price transparency'],
      }),
      sbPost: db.sbPost,
    }),
  });
  const handler = app._routes['POST /api/research/analyze'];
  await handler({ body: { userId: 'u1', reviews: ['too slow', 'bad coffee'] } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const rows = db.all('customer_insights');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'reviews');
  assert.match(rows[0].actionable_suggestion, /post about speed/);
});

// ─── ai-seo ─────────────────────────────────────────────────────────────────

test('routes/ai-seo: registers one endpoint', () => {
  const app = makeFakeApp();
  aiSeo.register({ app, ...sharedDeps() });
  assert.ok(app._routes['POST /api/ai-seo/optimize']);
});

test('routes/ai-seo: returns 400 without userId', async () => {
  const app = makeFakeApp();
  aiSeo.register({ app, ...sharedDeps() });
  const handler = app._routes['POST /api/ai-seo/optimize'];
  const res = makeRes();
  await handler({ body: {} }, res);
  assert.strictEqual(res._calls.status, 400);
});

test('routes/ai-seo: stores optimized content with type=full_optimization', async () => {
  const db = createFakeSupabase();
  const app = makeFakeApp();
  aiSeo.register({
    app,
    ...sharedDeps({
      callClaude: async () => ({
        faqs: [{ question: 'Q?', answer: 'A.' }],
        authority_paragraphs: ['Para 1'],
        target_queries: ['best cafe tirana', 'espresso near me'],
      }),
      sbPost: db.sbPost,
    }),
  });
  const handler = app._routes['POST /api/ai-seo/optimize'];
  await handler({ body: { userId: 'u1' } }, makeRes());
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const rows = db.all('ai_seo_content');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content_type, 'full_optimization');
  assert.match(rows[0].optimized_content, /best cafe tirana/);
});
