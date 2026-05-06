'use strict';

/**
 * tests/advisor-tool.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const advisor = require('../services/prompts/advisor-tool');

test('shouldUseAdvisor: free tier never uses advisor (cost protection)', () => {
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'audit', planTier: 'free' }), false);
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'strategy', planTier: 'free' }), false);
});

test('shouldUseAdvisor: quick budget never uses advisor', () => {
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'audit', budget: 'quick' }), false);
});

test('shouldUseAdvisor: growth+audit uses advisor', () => {
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'audit', budget: 'standard', planTier: 'growth' }), true);
});

test('shouldUseAdvisor: unknown tasks (lookup) do NOT use advisor', () => {
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'lookup', planTier: 'agency' }), false);
});

test('shouldUseAdvisor: env disable kills advisor everywhere', () => {
  const orig = process.env.MAROA_ADVISOR_ENABLED;
  process.env.MAROA_ADVISOR_ENABLED = 'false';
  assert.strictEqual(advisor.shouldUseAdvisor({ task: 'audit', planTier: 'agency' }), false);
  process.env.MAROA_ADVISOR_ENABLED = orig;
});

test('buildAdvisorOptions: includes beta header + executor model', () => {
  const o = advisor.buildAdvisorOptions({});
  assert.ok(o.extraBetas.includes(advisor.ADVISOR_BETA));
  assert.strictEqual(o.model, advisor.DEFAULT_EXECUTOR);
  assert.strictEqual(o.advisor.model, advisor.DEFAULT_ADVISOR);
});

test('buildAdvisorOptions: preserves existing beta headers', () => {
  const o = advisor.buildAdvisorOptions({ existingExtraBetas: ['files-api-2025-04-14'] });
  assert.ok(o.extraBetas.includes('files-api-2025-04-14'));
  assert.ok(o.extraBetas.includes(advisor.ADVISOR_BETA));
});

test('modelsFor: agency=Opus exec, growth=Sonnet exec + Opus advisor, free=Sonnet only', () => {
  assert.strictEqual(advisor.modelsFor('agency').executor, 'claude-opus-4-7');
  assert.strictEqual(advisor.modelsFor('growth').executor, 'claude-sonnet-4-5');
  assert.strictEqual(advisor.modelsFor('growth').advisor, 'claude-opus-4-7');
  assert.strictEqual(advisor.modelsFor('free').advisor, null);
});

test('callWithAdvisor: routes through callClaude with advisor extras when enabled', async () => {
  let capturedOpts = null;
  const fakeClaude = async (opts) => { capturedOpts = opts; return 'OK'; };
  const r = await advisor.callWithAdvisor({
    callClaude: fakeClaude,
    system: 's', user: 'u',
    task: 'audit', budget: 'standard', planTier: 'growth',
    executor: 'claude-sonnet-4-5', advisor: 'claude-opus-4-7',
  });
  assert.strictEqual(r, 'OK');
  assert.strictEqual(capturedOpts.model, 'claude-sonnet-4-5');
  assert.ok(capturedOpts.extra.extraBetas.includes(advisor.ADVISOR_BETA));
  assert.strictEqual(capturedOpts.extra.advisor.model, 'claude-opus-4-7');
});

test('callWithAdvisor: free tier silently degrades to executor-only (no advisor field)', async () => {
  let capturedOpts = null;
  const fakeClaude = async (opts) => { capturedOpts = opts; return 'OK'; };
  await advisor.callWithAdvisor({
    callClaude: fakeClaude,
    system: 's', user: 'u',
    task: 'audit', planTier: 'free',
  });
  assert.strictEqual(capturedOpts.extra.advisor, undefined);
});

test('callWithAdvisor: requires callClaude function', async () => {
  await assert.rejects(
    () => advisor.callWithAdvisor({ task: 'audit' }),
    /callClaude required/
  );
});
