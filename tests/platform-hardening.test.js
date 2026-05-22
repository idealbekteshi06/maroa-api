'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { enforceLLMBudget, LLMBudgetExceededError } = require('../lib/llmGateway');
const { checkPlatform } = require('../lib/integrationGate');
const { getPlatformSnapshot, CRITICAL_MIGRATIONS, probeCriticalMigrations } = require('../lib/platformOps');
const {
  collectRegisteredPaths,
  collectInngestInternalPaths,
} = require('../lib/scanDispatcherRegistry');
const { functions } = require('../services/inngest/functions');

test('llmGateway: denies when daily budget exceeded', async () => {
  await assert.rejects(
    () =>
      enforceLLMBudget({
        businessId: '11111111-1111-4111-8111-111111111111',
        sbGet: async () => [{ plan: 'starter' }],
        checkTokenBudgetForBusiness: async () => ({
          allowed: false,
          reason: 'Daily limit reached',
        }),
      }),
    (e) => e instanceof LLMBudgetExceededError
  );
});

test('llmGateway: denies when monthly cost cap exceeded', async () => {
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ plan: 'starter' }];
    if (table === 'llm_cost_logs') return [{ cost_usd: 40 }];
    return [];
  };
  await assert.rejects(
    () =>
      enforceLLMBudget({
        businessId: '22222222-2222-4222-8222-222222222222',
        sbGet,
        checkTokenBudgetForBusiness: async () => ({ allowed: true, maxTokensPerCall: 2000 }),
      }),
    (e) => e instanceof LLMBudgetExceededError && e.code === 'AI_COST_CAP_EXCEEDED'
  );
});

test('integrationGate: meta_ads requires token and page', () => {
  assert.strictEqual(
    checkPlatform({ meta_access_token: 'x', facebook_page_id: '1' }, 'meta_ads'),
    true
  );
  assert.strictEqual(checkPlatform({ meta_access_token: 'x' }, 'meta_ads'), false);
});

test('platformOps: critical migrations list includes 079 and 080', () => {
  assert.ok(CRITICAL_MIGRATIONS.includes('079_wf11_smart_routing.sql'));
  assert.ok(CRITICAL_MIGRATIONS.includes('080_quality_gate_runs.sql'));
});

test('platformOps: probeCriticalMigrations uses table existence not ledger', async () => {
  const sbGet = async (table, query) => {
    if (table === 'inbox_routing_settings') {
      assert.match(query, /select=business_id/);
      return [];
    }
    if (table === 'quality_gate_runs') {
      assert.match(query, /select=id/);
      return [];
    }
    throw new Error(`relation "public.${table}" does not exist`);
  };
  const r = await probeCriticalMigrations(sbGet);
  assert.equal(r.method, 'table_probe');
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing_in_db, []);
  assert.equal(r.tables.length, 2);
});

test('platformOps: probeCriticalMigrations reports missing table', async () => {
  const sbGet = async (table) => {
    if (table === 'inbox_routing_settings') return [];
    throw new Error('relation "public.quality_gate_runs" does not exist');
  };
  const r = await probeCriticalMigrations(sbGet);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing_in_db, ['080_quality_gate_runs.sql']);
});

test('inngest: content feedback path registered on dispatcher', () => {
  const registered = collectRegisteredPaths();
  assert.ok(registered.has('/webhook/wf-content-performance-feedback'));
});

test('inngest: all callInternal paths have dispatcher handlers', () => {
  const registered = collectRegisteredPaths();
  const paths = collectInngestInternalPaths();
  const missing = paths.filter((p) => !registered.has(p));
  assert.strictEqual(
    missing.length,
    0,
    `Inngest paths missing dispatcher: ${missing.join(', ')}`
  );
});

test('inngest: function count stable floor', () => {
  assert.ok(functions.length >= 25, `expected >= 25 functions, got ${functions.length}`);
});
