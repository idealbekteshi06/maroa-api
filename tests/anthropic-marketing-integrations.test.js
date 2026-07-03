'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  attachToolsToBody,
  buildAdvisorTool,
  buildWebSearchTool,
  cacheControlBlock,
} = require('../lib/claudeAnthropicTools');
const { checkWebSearchBudget, capForPlan } = require('../lib/webSearchGate');
const advisor = require('../services/prompts/advisor-tool');
const { createBatchService } = require('../services/anthropic-batch');

test('claudeAnthropicTools: advisor + web search attach to body', () => {
  const body = { model: 'claude-sonnet-5', messages: [] };
  attachToolsToBody(body, {
    advisor: { model: 'claude-opus-4-8', maxUses: 3 },
    webSearch: { maxUses: 5, dynamicFilter: true },
  });
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].type, 'advisor_20260301');
  assert.equal(body.tools[1].type, 'web_search_20260209');
});

test('cacheControlBlock: 1h ttl for overnight batches', () => {
  assert.deepEqual(cacheControlBlock('1h'), { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(cacheControlBlock(), { type: 'ephemeral' });
});

test('advisor-tool: competitor + ai-seo + creative tasks enabled', () => {
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'competitor', planTier: 'growth' }), true);
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'ai-seo', planTier: 'growth' }), true);
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'creative', planTier: 'agency' }), true);
});

test('advisor-tool: default executor is Sonnet 5', () => {
  assert.strictEqual(advisor.DEFAULT_EXECUTOR, 'claude-sonnet-5');
  assert.strictEqual(advisor.modelsFor('growth').executor, 'claude-sonnet-5');
});

test('webSearchGate: starter has zero cap', () => {
  assert.strictEqual(capForPlan('starter'), 0);
  assert.strictEqual(capForPlan('growth'), 25);
});

test('webSearchGate: denies when cap exceeded', async () => {
  const businessId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sbGet = async (table, q) => {
    if (table === 'llm_cost_logs' && q.includes('web_search')) {
      return Array.from({ length: 25 }, (_, i) => ({ id: `w${i}` }));
    }
    return [];
  };
  const gate = await checkWebSearchBudget({ businessId, sbGet, plan: 'growth' });
  assert.strictEqual(gate.allowed, false);
});

test('anthropic-batch: cacheTtl 1h on system block', () => {
  const svc = createBatchService({
    apiKey: 'test',
    logger: {},
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
  });
  const req = svc.buildRequest({
    customId: 'nightly',
    model: 'claude-sonnet-5',
    system: 'shared prefix',
    prompt: 'q',
    cacheSystem: true,
    cacheTtl: '1h',
  });
  assert.deepEqual(req.params.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('buildAdvisorTool includes max_uses', () => {
  const t = buildAdvisorTool({ maxUses: 5 });
  assert.equal(t.max_uses, 5);
});
