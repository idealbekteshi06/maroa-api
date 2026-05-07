'use strict';

const test = require('node:test');
const assert = require('node:assert');

const obs = require('../services/observability');
const metrics = obs.metrics;
const costTracker = obs.costTracker;

// ─── Logger ───────────────────────────────────────────────────────────────

test('logger: makeLogger returns object with debug/info/warn/error/cost/time', () => {
  const log = obs.makeLogger('test-module');
  assert.strictEqual(typeof log.debug, 'function');
  assert.strictEqual(typeof log.info, 'function');
  assert.strictEqual(typeof log.warn, 'function');
  assert.strictEqual(typeof log.error, 'function');
  assert.strictEqual(typeof log.cost, 'function');
  assert.strictEqual(typeof log.time, 'function');
});

test('logger: time() returns function that logs duration', () => {
  const log = obs.makeLogger('test');
  const done = log.time('operation');
  assert.strictEqual(typeof done, 'function');
  const dur = done();
  assert.ok(typeof dur === 'number');
  assert.ok(dur >= 0);
});

// ─── Metrics ──────────────────────────────────────────────────────────────

test('metrics: increment counter', () => {
  metrics.reset();
  metrics.increment('test_counter');
  metrics.increment('test_counter');
  metrics.increment('test_counter');
  const snap = metrics.snapshot();
  assert.strictEqual(snap.counters['test_counter'], 3);
});

test('metrics: increment with labels', () => {
  metrics.reset();
  metrics.increment('http_requests_total', { method: 'GET', status: '200' });
  metrics.increment('http_requests_total', { method: 'GET', status: '200' });
  metrics.increment('http_requests_total', { method: 'POST', status: '200' });
  const snap = metrics.snapshot();
  assert.ok(snap.counters['http_requests_total{method="GET",status="200"}'] === 2);
  assert.ok(snap.counters['http_requests_total{method="POST",status="200"}'] === 1);
});

test('metrics: setGauge replaces value', () => {
  metrics.reset();
  metrics.setGauge('business_count', 50);
  metrics.setGauge('business_count', 100);
  const snap = metrics.snapshot();
  assert.strictEqual(snap.gauges['business_count'], 100);
});

test('metrics: observeHistogram tracks count + sum + buckets', () => {
  metrics.reset();
  metrics.observeHistogram('latency_ms', 50);
  metrics.observeHistogram('latency_ms', 100);
  metrics.observeHistogram('latency_ms', 250);
  const snap = metrics.snapshot();
  const h = snap.histograms['latency_ms'];
  assert.strictEqual(h.count, 3);
  assert.strictEqual(h.sum, 400);
  assert.ok(h.avg >= 100 && h.avg <= 200);
  // Buckets accumulate (a value that fits a bucket increments all higher buckets too)
  assert.ok(h.buckets[100] >= 2, '100ms bucket should have 50 + 100');
  assert.ok(h.buckets[1000] >= 3, '1000ms bucket should have all 3');
});

test('metrics: exportPrometheus produces valid format', () => {
  metrics.reset();
  metrics.increment('foo_total', { label: 'a' });
  metrics.setGauge('bar_gauge', 42);
  metrics.observeHistogram('baz_hist', 100);
  const text = metrics.exportPrometheus();
  assert.match(text, /# TYPE foo_total counter/);
  assert.match(text, /foo_total{label="a"} 1/);
  assert.match(text, /# TYPE bar_gauge gauge/);
  assert.match(text, /bar_gauge 42/);
  assert.match(text, /# TYPE baz_hist histogram/);
});

test('metrics: expressMiddleware tracks http requests', (t, done) => {
  metrics.reset();
  const middleware = metrics.expressMiddleware();
  const req = { method: 'GET', path: '/test', route: { path: '/test' } };
  const res = {
    statusCode: 200,
    listeners: {},
    on: function (e, cb) { this.listeners[e] = cb; },
  };
  middleware(req, res, () => {});
  res.listeners['finish']();
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some(k => k.startsWith('http_requests_total')));
  done();
});

// ─── Cost Tracker ────────────────────────────────────────────────────────

test('cost-tracker: calcCost — Sonnet input/output', () => {
  // Sonnet: $3/MTok input, $15/MTok output
  // 1000 input + 500 output = (1000/1e6 * 3) + (500/1e6 * 15) = 0.003 + 0.0075 = 0.0105
  const cost = costTracker.calcCost(
    { input_tokens: 1000, output_tokens: 500 },
    'claude-sonnet-4-5'
  );
  assert.ok(cost > 0.01 && cost < 0.012, `expected ~0.0105, got ${cost}`);
});

test('cost-tracker: calcCost — Opus more expensive than Sonnet', () => {
  const usage = { input_tokens: 1000, output_tokens: 500 };
  const sonnet = costTracker.calcCost(usage, 'claude-sonnet-4-5');
  const opus = costTracker.calcCost(usage, 'claude-opus-4-7');
  assert.ok(opus > sonnet * 1.5, `Opus should be >1.5x Sonnet: opus=${opus}, sonnet=${sonnet}`);
});

test('cost-tracker: calcCost — cache discount applied (input-heavy, realistic)', () => {
  // Use input-heavy tokens (typical of prompt caching scenarios where the
  // long system prompt is cached). Output stays small.
  const noCache = costTracker.calcCost(
    { input_tokens: 10000, output_tokens: 100 },
    'claude-sonnet-4-5'
  );
  const withCache = costTracker.calcCost(
    { input_tokens: 10000, output_tokens: 100, cache_read_input_tokens: 9000 },
    'claude-sonnet-4-5'
  );
  // 90% of input cached → expect at least 50% total savings (output dominates remaining cost)
  assert.ok(withCache < noCache * 0.5, `cached should be <50% uncached: cached=${withCache}, uncached=${noCache}`);
});

test('cost-tracker: track records metrics + returns cost', async () => {
  metrics.reset();
  const cost = await costTracker.track({
    businessId: 'biz-1',
    skill: 'ad-optimizer',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 1000, output_tokens: 500 },
    sbPost: null, // no DB write in test
  });
  assert.ok(cost > 0);
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some(k => k.includes('llm_calls_total')));
  assert.ok(Object.keys(snap.counters).some(k => k.includes('llm_tokens_input_total')));
});

test('cost-tracker: track persists to DB when sbPost provided', async () => {
  let inserted = null;
  await costTracker.track({
    businessId: 'biz-1',
    skill: 'voice-polish',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 100, output_tokens: 50 },
    sbPost: async (table, row) => { inserted = { table, row }; },
  });
  assert.ok(inserted);
  assert.strictEqual(inserted.table, 'llm_cost_logs');
  assert.strictEqual(inserted.row.skill, 'voice-polish');
  assert.strictEqual(inserted.row.input_tokens, 100);
  assert.strictEqual(inserted.row.output_tokens, 50);
  assert.ok(inserted.row.cost_usd > 0);
});

test('cost-tracker: track gracefully handles sbPost failure', async () => {
  // Should not throw; cost still calculated
  const cost = await costTracker.track({
    businessId: 'biz-1',
    skill: 'cro',
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 100, output_tokens: 50 },
    sbPost: async () => { throw new Error('DB down'); },
    logger: { warn: () => {} },
  });
  assert.ok(cost > 0);
});

test('cost-tracker: buildCostReport aggregates correctly', async () => {
  const fakeRows = [
    { business_id: 'b1', skill: 'ad-optimizer', model: 'claude-sonnet-4-5', cost_usd: 0.10, created_at: '2026-05-07' },
    { business_id: 'b1', skill: 'ad-optimizer', model: 'claude-sonnet-4-5', cost_usd: 0.20, created_at: '2026-05-07' },
    { business_id: 'b2', skill: 'cro',          model: 'claude-opus-4-7',   cost_usd: 0.50, created_at: '2026-05-07' },
  ];
  const sbGet = async () => fakeRows;
  const r = await costTracker.buildCostReport({ sbGet, days: 7 });
  assert.strictEqual(r.total_calls, 3);
  assert.strictEqual(r.total_cost_usd, 0.80);
  assert.strictEqual(r.top_businesses[0].business_id, 'b2');
  assert.strictEqual(r.by_skill['cro'], 0.50);
  assert.strictEqual(r.by_skill['ad-optimizer'], 0.30);
});
