'use strict';

/**
 * lib/platformAnthropic.js — Anthropic 2026 platform constants & helpers.
 */

const BETAS = {
  PROMPT_CACHE: 'prompt-caching-2024-07-31',
  EXTENDED_OUTPUT: 'output-300k-2026-03-24',
  CODE_EXECUTION: 'code-execution-2025-08-25',
  ADVISOR: 'advisor-tool-2026-03-01',
  MANAGED_AGENTS: 'managed-agents-2026-04-01',
  FILES: 'files-api-2025-04-14',
  BATCHES: 'message-batches-2024-09-24',
};

const CODE_EXECUTION_TOOL = 'code_execution_20260120';

/** Models eligible for 300k batch output (Anthropic docs, May 2026). */
const EXTENDED_OUTPUT_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);

const BATCH_MAX_TOKENS_EXTENDED = 300_000;
const BATCH_MAX_TOKENS_DEFAULT = 64_000;

function supportsExtendedOutput(model) {
  return EXTENDED_OUTPUT_MODELS.has(String(model || '').toLowerCase());
}

/**
 * Plan-aware batch output cap — avoids runaway cost while using extended beta.
 */
function batchMaxTokensForPlan(plan, purpose = 'default') {
  const p = String(plan || 'starter').toLowerCase();
  if (purpose === 'wf1_monthly' || purpose === 'monthly_content') {
    if (p === 'agency') return 131_072;
    if (p === 'growth') return 32_768;
    return 8_192;
  }
  if (purpose === 'weekly_scorecard') {
    if (p === 'agency') return 24_576;
    if (p === 'growth') return 12_288;
    return 4_096;
  }
  if (p === 'agency') return 65_536;
  if (p === 'growth') return 16_384;
  return 4_096;
}

function extendedBetasForMaxTokens(maxTokens) {
  return Number(maxTokens) > BATCH_MAX_TOKENS_DEFAULT ? [BETAS.EXTENDED_OUTPUT] : [];
}

module.exports = {
  BETAS,
  CODE_EXECUTION_TOOL,
  EXTENDED_OUTPUT_MODELS,
  BATCH_MAX_TOKENS_EXTENDED,
  BATCH_MAX_TOKENS_DEFAULT,
  supportsExtendedOutput,
  batchMaxTokensForPlan,
  extendedBetasForMaxTokens,
};
