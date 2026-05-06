'use strict';

/**
 * services/prompts/execution-mode/index.js
 * ----------------------------------------------------------------------------
 * Cross-cutting execution-mode helpers for all Maroa skill modules.
 *
 * Modes (semantically-precise, plan-tier-mapped, explicit-override-able):
 *
 *   quick    — single-pass deterministic + minimal LLM, 1-3 top findings.
 *               ≤700 tokens. Sub-second. Free tier default.
 *   standard — full deterministic checks + LLM synthesis with cache.
 *               ≤2500 tokens. ~5s. Growth tier default.
 *   deep     — full + parallel-agent + Opus 4.7 + Files API + multi-pass refine.
 *               ≤6000 tokens. ~15s. Agency tier default.
 *
 * Public API:
 *   resolveMode(plan, override?)  → 'quick' | 'standard' | 'deep'
 *   sliceFindings(findings, mode) → array sliced to mode's depth
 *   tokenBudgetFor(mode, kind?)   → max_tokens cap
 *   modelFor(mode)                → 'claude-sonnet-4-5' | 'claude-opus-4-7'
 *   shouldUseParallelAgents(mode) → bool
 *   shouldUseFilesApi(mode)       → bool
 *   temperatureFor(mode, task?)   → number
 *
 * Backwards compatible: existing modules that pass `plan` keep working —
 * resolveMode auto-derives if no executionMode is provided.
 * ----------------------------------------------------------------------------
 */

const VALID_MODES = ['quick', 'standard', 'deep'];

const PLAN_DEFAULTS = {
  free: 'quick',
  growth: 'standard',
  agency: 'deep',
  enterprise: 'deep',
};

/**
 * Resolve the effective execution mode.
 * Priority: explicit override > plan default > 'quick' fallback.
 */
function resolveMode(plan, override) {
  if (override && VALID_MODES.includes(String(override).toLowerCase())) {
    return String(override).toLowerCase();
  }
  const p = String(plan || 'free').toLowerCase();
  return PLAN_DEFAULTS[p] || 'quick';
}

/**
 * Slice findings array to the mode's display depth.
 *
 * quick: top 3 by priority desc + severity weight
 * standard: top 12
 * deep: all
 */
function sliceFindings(findings, mode) {
  if (!Array.isArray(findings)) return [];
  const m = String(mode || 'standard').toLowerCase();
  if (m === 'quick')    return findings.slice(0, 3);
  if (m === 'standard') return findings.slice(0, 12);
  return findings.slice();
}

/**
 * Cap on max_tokens for the LLM call.
 * Differs by kind: 'audit' (smaller) vs 'generate' / 'rewrite' (larger).
 */
function tokenBudgetFor(mode, kind = 'audit') {
  const m = String(mode || 'standard').toLowerCase();
  if (kind === 'generate' || kind === 'rewrite') {
    if (m === 'deep')     return 6000;
    if (m === 'standard') return 2500;
    return 1000;
  }
  if (m === 'deep')     return 4000;
  if (m === 'standard') return 2200;
  return 700;
}

/**
 * Pick the model for the mode.
 */
function modelFor(mode) {
  return String(mode || 'standard').toLowerCase() === 'deep'
    ? 'claude-opus-4-7'
    : 'claude-sonnet-4-5';
}

function shouldUseParallelAgents(mode) {
  return String(mode || 'standard').toLowerCase() === 'deep';
}

function shouldUseFilesApi(mode) {
  return String(mode || 'standard').toLowerCase() === 'deep';
}

function shouldCacheSystem(_mode) {
  // Always cache — saves cost across all modes.
  return true;
}

/**
 * Temperature varies by task:
 *   audit (decisions)       → low (0.2) — we want consistency
 *   rewrite (creative copy) → mid (0.5) — variety helps
 *   generate (artifacts)    → mid (0.4)
 */
function temperatureFor(_mode, task = 'audit') {
  if (task === 'rewrite') return 0.5;
  if (task === 'generate') return 0.4;
  return 0.2;
}

/**
 * Build a single config blob the caller can spread into their LLM call.
 *   const cfg = buildExecutionConfig({ plan, override, kind: 'audit' });
 *   await callClaude({ ...cfg, system, user });
 */
function buildExecutionConfig({ plan, override, kind = 'audit' }) {
  const mode = resolveMode(plan, override);
  return {
    mode,
    model: modelFor(mode),
    max_tokens: tokenBudgetFor(mode, kind),
    extra: {
      cacheSystem: shouldCacheSystem(mode),
      temperature: temperatureFor(mode, kind),
    },
    parallel_agents: shouldUseParallelAgents(mode),
    use_files_api: shouldUseFilesApi(mode),
  };
}

/**
 * Quick guard: is the resolved mode allowed for the given plan?
 * Prevents free users from forcing 'deep' mode (cost protection).
 */
function isModeAllowedForPlan(plan, requestedMode) {
  const p = String(plan || 'free').toLowerCase();
  const m = String(requestedMode || 'quick').toLowerCase();
  if (p === 'free'   && m === 'deep')     return false;
  if (p === 'free'   && m === 'standard') return false;
  if (p === 'growth' && m === 'deep')     return false;
  return true;
}

module.exports = {
  VALID_MODES,
  PLAN_DEFAULTS,
  resolveMode,
  sliceFindings,
  tokenBudgetFor,
  modelFor,
  shouldUseParallelAgents,
  shouldUseFilesApi,
  shouldCacheSystem,
  temperatureFor,
  buildExecutionConfig,
  isModeAllowedForPlan,
};
