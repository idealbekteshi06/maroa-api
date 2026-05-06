'use strict';

/**
 * tests/execution-mode.test.js
 * Test suite for the cross-cutting execution-mode helpers.
 */

const test = require('node:test');
const assert = require('node:assert');

const em = require('../services/prompts/execution-mode');

// ─── 1-3. resolveMode ──────────────────────────────────────────────────────

test('resolveMode: maps plans to correct defaults', () => {
  assert.strictEqual(em.resolveMode('free'), 'quick');
  assert.strictEqual(em.resolveMode('growth'), 'standard');
  assert.strictEqual(em.resolveMode('agency'), 'deep');
});

test('resolveMode: explicit override wins over plan default', () => {
  assert.strictEqual(em.resolveMode('agency', 'quick'), 'quick');
  assert.strictEqual(em.resolveMode('free', 'deep'), 'deep'); // unsafe — caller responsibility
  assert.strictEqual(em.resolveMode('free', 'standard'), 'standard');
});

test('resolveMode: invalid override falls back to plan default', () => {
  assert.strictEqual(em.resolveMode('growth', 'turbo'), 'standard');
  assert.strictEqual(em.resolveMode('free', null), 'quick');
  assert.strictEqual(em.resolveMode(undefined), 'quick');
});

// ─── 4. sliceFindings ─────────────────────────────────────────────────────

test('sliceFindings: quick=3, standard=12, deep=all', () => {
  const findings = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  assert.strictEqual(em.sliceFindings(findings, 'quick').length, 3);
  assert.strictEqual(em.sliceFindings(findings, 'standard').length, 12);
  assert.strictEqual(em.sliceFindings(findings, 'deep').length, 20);
});

// ─── 5. tokenBudgetFor ────────────────────────────────────────────────────

test('tokenBudgetFor: deep > standard > quick; rewrite > audit', () => {
  const quickAudit = em.tokenBudgetFor('quick', 'audit');
  const standardAudit = em.tokenBudgetFor('standard', 'audit');
  const deepAudit = em.tokenBudgetFor('deep', 'audit');
  assert.ok(quickAudit < standardAudit && standardAudit < deepAudit);

  const standardAuditCheck = em.tokenBudgetFor('standard', 'audit');
  const standardRewrite = em.tokenBudgetFor('standard', 'rewrite');
  assert.ok(standardRewrite > standardAuditCheck, 'rewrite tasks need more tokens than audit');
});

// ─── 6. modelFor ──────────────────────────────────────────────────────────

test('modelFor: deep uses Opus 4.7, others use Sonnet 4.5', () => {
  assert.strictEqual(em.modelFor('deep'), 'claude-opus-4-7');
  assert.strictEqual(em.modelFor('standard'), 'claude-sonnet-4-5');
  assert.strictEqual(em.modelFor('quick'), 'claude-sonnet-4-5');
});

// ─── 7. parallel agents + files API gates ─────────────────────────────────

test('shouldUseParallelAgents: only on deep', () => {
  assert.strictEqual(em.shouldUseParallelAgents('deep'), true);
  assert.strictEqual(em.shouldUseParallelAgents('standard'), false);
  assert.strictEqual(em.shouldUseParallelAgents('quick'), false);
});

test('shouldUseFilesApi: only on deep', () => {
  assert.strictEqual(em.shouldUseFilesApi('deep'), true);
  assert.strictEqual(em.shouldUseFilesApi('standard'), false);
});

// ─── 8. temperature task awareness ────────────────────────────────────────

test('temperatureFor: rewrite > generate > audit', () => {
  const aud = em.temperatureFor('standard', 'audit');
  const gen = em.temperatureFor('standard', 'generate');
  const rew = em.temperatureFor('standard', 'rewrite');
  assert.ok(rew > gen && gen > aud, `expected rewrite > generate > audit, got ${rew}, ${gen}, ${aud}`);
});

// ─── 9. buildExecutionConfig ──────────────────────────────────────────────

test('buildExecutionConfig: returns full config blob', () => {
  const cfg = em.buildExecutionConfig({ plan: 'agency', kind: 'audit' });
  assert.strictEqual(cfg.mode, 'deep');
  assert.strictEqual(cfg.model, 'claude-opus-4-7');
  assert.ok(cfg.max_tokens > 0);
  assert.strictEqual(cfg.extra.cacheSystem, true);
  assert.strictEqual(cfg.parallel_agents, true);
});

// ─── 10. isModeAllowedForPlan ─────────────────────────────────────────────

test('isModeAllowedForPlan: free cannot force deep, agency unrestricted', () => {
  assert.strictEqual(em.isModeAllowedForPlan('free', 'deep'), false);
  assert.strictEqual(em.isModeAllowedForPlan('free', 'standard'), false);
  assert.strictEqual(em.isModeAllowedForPlan('free', 'quick'), true);
  assert.strictEqual(em.isModeAllowedForPlan('growth', 'standard'), true);
  assert.strictEqual(em.isModeAllowedForPlan('growth', 'deep'), false);
  assert.strictEqual(em.isModeAllowedForPlan('agency', 'deep'), true);
  assert.strictEqual(em.isModeAllowedForPlan('agency', 'quick'), true); // can downgrade
});
