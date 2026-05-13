'use strict';

/**
 * tests/agency-generate-route.test.js
 *
 * Wave 60 production-readiness — verifies the HTTP surface for the master
 * pipeline behaves correctly under the feature flag and surfaces telemetry.
 */

const test = require('node:test');
const assert = require('node:assert');

const agencyRoute = require('../routes/agency-generate');

function makeFakeApp() {
  const handlers = new Map();
  return {
    handlers,
    post(path, ...args) {
      const handler = args[args.length - 1];
      const middlewares = args.slice(0, -1);
      handlers.set(path, { handler, middlewares });
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function makeMetrics() {
  const counters = [];
  const histograms = [];
  return {
    counters,
    histograms,
    increment(name, labels, by = 1) {
      counters.push({ name, labels, by });
    },
    observeHistogram(name, value, labels) {
      histograms.push({ name, value, labels });
    },
  };
}

// ─── Feature flag OFF ─────────────────────────────────────────────────────

test('route: returns 503 feature_disabled when AGENCY_PIPELINE_ENABLED is unset', async () => {
  const app = makeFakeApp();
  const metrics = makeMetrics();
  agencyRoute.register({ app, env: {}, metrics });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  handler({ body: {} }, res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.reason, 'feature_disabled');
  assert.ok(metrics.counters.some((c) => c.labels && c.labels.outcome === 'feature_disabled'));
});

test('route: returns 503 feature_disabled when flag is "0"', async () => {
  const app = makeFakeApp();
  agencyRoute.register({ app, env: { AGENCY_PIPELINE_ENABLED: '0' }, metrics: makeMetrics() });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  handler({ body: {} }, res);
  assert.strictEqual(res.statusCode, 503);
});

// ─── Feature flag ON ──────────────────────────────────────────────────────

test('route: 400 when businessId missing', async () => {
  const app = makeFakeApp();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics: makeMetrics(),
    callClaude: async () => 'ok',
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler({ body: { goal: 'x' }, query: {} }, res);
  assert.strictEqual(res.statusCode, 400);
});

test('route: 400 when goal missing', async () => {
  const app = makeFakeApp();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics: makeMetrics(),
    callClaude: async () => 'ok',
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler({ body: { businessId: 'b1' }, query: {} }, res);
  assert.strictEqual(res.statusCode, 400);
});

test('route: 200 + ok=true for clean compliant generation', async () => {
  const app = makeFakeApp();
  const metrics = makeMetrics();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics,
    callClaude: async () => 'A friendly Instagram caption about our café.',
    sbPost: async () => [{ id: 'run-xyz' }],
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler(
    {
      body: {
        businessId: 'b1',
        goal: 'Write an Instagram caption',
        channel: 'instagram-post',
        industry: 'cafe',
      },
      query: {},
    },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.generation);
  // metrics must be recorded
  assert.ok(metrics.counters.some((c) => c.name === 'agency_pipeline_calls_total' && c.labels.outcome === 'ok'));
  assert.ok(metrics.histograms.some((h) => h.name === 'agency_pipeline_duration_ms'));
});

test('route: 422 + refused=true on compliance violation', async () => {
  const app = makeFakeApp();
  const metrics = makeMetrics();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics,
    callClaude: async () => 'Guaranteed mortgage approval — no credit check needed.',
    sbPost: async () => [{ id: 'run-xyz' }],
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler(
    {
      body: {
        businessId: 'b1',
        goal: 'Write a mortgage ad',
        channel: 'meta-ads-image',
        industry: 'mortgage_broker',
      },
      query: {},
    },
    res
  );
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.body.refused, true);
  assert.ok(/compliance/i.test(res.body.refusal_reason));
  assert.ok(
    metrics.counters.some(
      (c) => c.name === 'agency_pipeline_calls_total' && c.labels.outcome === 'refused_compliance'
    )
  );
  assert.ok(metrics.counters.some((c) => c.name === 'agency_pipeline_refusals_total'));
});

test('route: prompt_segments hidden by default, exposed with ?trace=1', async () => {
  const app = makeFakeApp();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics: makeMetrics(),
    callClaude: async () => 'A nice Instagram caption about our café.',
    sbPost: async () => [{ id: 'run-xyz' }],
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');

  const resNoTrace = makeRes();
  await handler(
    {
      body: { businessId: 'b1', goal: 'IG caption', channel: 'instagram-post', industry: 'cafe' },
      query: {},
    },
    resNoTrace
  );
  assert.strictEqual(resNoTrace.body.prompt_segments, undefined);

  const resWithTrace = makeRes();
  await handler(
    {
      body: { businessId: 'b1', goal: 'IG caption', channel: 'instagram-post', industry: 'cafe' },
      query: { trace: '1' },
    },
    resWithTrace
  );
  assert.ok(Array.isArray(resWithTrace.body.prompt_segments));
  assert.ok(resWithTrace.body.prompt_segments.length > 0);
});

test('route: persistRun called with audit row', async () => {
  const inserts = [];
  const app = makeFakeApp();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics: makeMetrics(),
    callClaude: async () => 'An on-brand café caption.',
    sbPost: async (table, row) => {
      inserts.push({ table, row });
      return [{ id: 'run-xyz' }];
    },
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler(
    {
      body: { businessId: 'b1', goal: 'IG caption', channel: 'instagram-post', industry: 'cafe' },
      query: {},
    },
    res
  );
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].table, 'agency_pipeline_runs');
  assert.strictEqual(inserts[0].row.business_id, 'b1');
});

test('route: persistRun failure does NOT crash the response', async () => {
  const metrics = makeMetrics();
  const app = makeFakeApp();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics,
    callClaude: async () => 'An on-brand café caption.',
    sbPost: async () => {
      throw new Error('db down');
    },
  });
  const { handler } = app.handlers.get('/webhook/agency-generate');
  const res = makeRes();
  await handler(
    {
      body: { businessId: 'b1', goal: 'IG caption', channel: 'instagram-post', industry: 'cafe' },
      query: {},
    },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.ok(metrics.counters.some((c) => c.name === 'agency_pipeline_persist_errors_total'));
});

test('route: middleware chain wires aiRateLimit + costGuard when supplied', () => {
  const app = makeFakeApp();
  const aiRateLimit = (req, res, next) => next();
  const costGuard = (req, res, next) => next();
  const requireAuthOrWebhookSecret = (req, res, next) => next();
  agencyRoute.register({
    app,
    env: { AGENCY_PIPELINE_ENABLED: '1' },
    metrics: makeMetrics(),
    callClaude: async () => '',
    aiRateLimit,
    costGuard,
    requireAuthOrWebhookSecret,
  });
  const { middlewares } = app.handlers.get('/webhook/agency-generate');
  assert.strictEqual(middlewares.length, 3);
  assert.ok(middlewares.includes(requireAuthOrWebhookSecret));
  assert.ok(middlewares.includes(aiRateLimit));
  assert.ok(middlewares.includes(costGuard));
});
