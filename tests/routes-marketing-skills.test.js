'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { register } = require('../routes/marketing-skills');

function harness({ claudeReturn } = {}) {
  const routes = {};
  const app = {
    get: (p, h) => (routes['GET ' + p] = h),
    post: (p, h) => (routes['POST ' + p] = h),
  };
  const calls = { claude: 0, post: 0, patch: 0 };
  const deps = {
    app,
    getProfile: async () => ({
      business_name: 'Test Cafe',
      business_type: 'cafe',
      physical_locations: [{ city: 'Pristina' }],
      primary_language: 'English',
    }),
    callClaude: async () => {
      calls.claude++;
      return claudeReturn !== undefined ? claudeReturn : {};
    },
    claudeBiz: (u) => ({ businessId: u }),
    extractJSON: (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
    sbGet: async () => [],
    sbPost: async () => {
      calls.post++;
      return {};
    },
    sbPatch: async () => {
      calls.patch++;
      return {};
    },
    log: () => {},
    safePublicError: (e) => String((e && e.message) || e),
    pCity: (p) => (p && p.physical_locations && p.physical_locations[0] && p.physical_locations[0].city) || 'local',
  };
  register(deps);
  return { routes, calls };
}

function mkRes() {
  const r = { code: 200 };
  r.status = (c) => {
    r.code = c;
    return r;
  };
  r.json = (o) => {
    r.body = o;
    return r;
  };
  return r;
}

const call = (routes, key, body = {}, params = {}) => {
  const req = { body: { ...body, user_id: 'u1' }, params, user: { id: 'u1' }, get: () => '' };
  const res = mkRes();
  return Promise.resolve(routes[key](req, res)).then(() => res);
};

test('marketing-skills: registers all 19 routes', () => {
  const { routes } = harness();
  const expected = [
    'POST /api/ab-tests/create',
    'POST /api/community/generate-posts',
    'POST /api/onboarding-cro/generate',
    'POST /api/orchestrator/run',
    'GET /api/orchestrator/log/:businessId',
    'POST /api/popup/generate',
    'POST /api/pricing/analyze',
    'POST /api/revops/score-lead',
    'GET /api/revops/scores/:businessId',
    'POST /api/sales/generate-pitch',
    'POST /api/sales/objection-handler',
    'POST /api/schema/generate',
    'POST /api/seo-pages/generate',
    'POST /api/signup-cro/analyze',
    'POST /api/tools/suggest',
    'POST /api/upgrade/generate-prompts',
    'POST /webhook/ai-chat',
    'POST /webhook/build-brand-dna',
    'GET /api/business/:businessId/brand-dna',
  ];
  for (const k of expected) assert.ok(routes[k], `missing route ${k}`);
  assert.strictEqual(Object.keys(routes).length, expected.length);
});

test('ab-tests/create returns normalized ABTest shape', async () => {
  const { routes } = harness({
    claudeReturn: {
      variants: [{ name: 'A', impressions: 100, clicks: 9, conversions: 2, confidence: 80 }],
      winner: 'A',
    },
  });
  const res = await call(routes, 'POST /api/ab-tests/create', { test_type: 'headline', variants: ['A', 'B'] });
  assert.strictEqual(res.code, 200);
  assert.ok(res.body.id && res.body.created_at);
  assert.strictEqual(res.body.status, 'completed');
  assert.strictEqual(res.body.variants[0].impressions, 100);
});

test('community/generate-posts returns an array', async () => {
  const { routes } = harness({ claudeReturn: [{ title: 't', body: 'b', subreddit_or_group: 'r/x' }] });
  const res = await call(routes, 'POST /api/community/generate-posts', { platform: 'reddit' });
  assert.ok(Array.isArray(res.body));
  assert.strictEqual(res.body[0].platform, 'reddit');
  assert.ok(res.body[0].id);
});

test('pricing/analyze coerces numbers and arrays', async () => {
  const { routes } = harness({
    claudeReturn: {
      recommendations: [
        { product: 'Latte', current_price: '3', recommended_price: '3.5', change_percent: '16', reasoning: 'x' },
      ],
      competitor_prices: [{ competitor: 'R', price: '4', difference: '14% higher' }],
      elasticity_score: '7',
      summary: 's',
    },
  });
  const res = await call(routes, 'POST /api/pricing/analyze');
  assert.strictEqual(res.body.recommendations[0].current_price, 3);
  assert.strictEqual(res.body.elasticity_score, 7);
  assert.strictEqual(res.body.competitor_prices[0].price, 4);
});

test('schema/generate stringifies JSON-LD', async () => {
  const { routes } = harness({ claudeReturn: { schema: { '@type': 'LocalBusiness', name: 'X' } } });
  const res = await call(routes, 'POST /api/schema/generate', { page_type: 'LocalBusiness' });
  assert.match(res.body.json_ld, /LocalBusiness/);
  assert.strictEqual(res.body.page_type, 'LocalBusiness');
});

test('ai-chat returns a reply string', async () => {
  const { routes } = harness({ claudeReturn: { reply: 'advice' } });
  const res = await call(routes, 'POST /webhook/ai-chat', { message: 'help', business_id: 'b1' });
  assert.strictEqual(res.body.reply, 'advice');
});

test('ai-chat 400s without a message', async () => {
  const { routes } = harness();
  const res = await call(routes, 'POST /webhook/ai-chat', { business_id: 'b1' });
  assert.strictEqual(res.code, 400);
});

test('GET list endpoints return empty arrays (no persistence layer)', async () => {
  const { routes } = harness();
  const log = await call(routes, 'GET /api/orchestrator/log/:businessId', {}, { businessId: 'b1' });
  const scores = await call(routes, 'GET /api/revops/scores/:businessId', {}, { businessId: 'b1' });
  assert.deepStrictEqual(log.body, { logs: [] });
  assert.deepStrictEqual(scores.body, { leads: [] });
});

test('build-brand-dna persists when DNA is generated', async () => {
  const { routes, calls } = harness({ claudeReturn: { tone_keywords: ['warm'], personality: 'p' } });
  const res = await call(routes, 'POST /webhook/build-brand-dna', { business_id: 'b1' });
  assert.strictEqual(res.code, 200);
  assert.ok(calls.post === 1 || calls.patch === 1, 'should upsert business_profiles');
});

test('handler surfaces 500 on callClaude throw', async () => {
  const routes = {};
  const app = { get: (p, h) => (routes['GET ' + p] = h), post: (p, h) => (routes['POST ' + p] = h) };
  register({
    app,
    getProfile: async () => ({}),
    callClaude: async () => {
      throw new Error('boom');
    },
    claudeBiz: () => ({}),
    extractJSON: () => null,
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    log: () => {},
    safePublicError: (e) => String((e && e.message) || e),
    pCity: () => 'local',
  });
  const res = await call(routes, 'POST /api/popup/generate', { popup_type: 'exit-intent' });
  assert.strictEqual(res.code, 500);
});
