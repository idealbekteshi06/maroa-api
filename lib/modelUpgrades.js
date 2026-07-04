'use strict';

/**
 * lib/modelUpgrades.js — central model-generation upgrade layer (2026-07).
 *
 * Maroa migrated Sonnet 4.5/4.6 → Claude Sonnet 5 and Opus 4.7 → Opus 4.8.
 * Every Anthropic request path (callClaude, Batch API builders, advisor tool)
 * normalizes through this map, so a stale constant anywhere — env var, DB row,
 * prompt module — still lands on the current generation instead of a
 * deprecated (and eventually retired → 404) model.
 *
 * Why the 5-family needs more than an ID swap (see Anthropic migration guide):
 *  - Sonnet 5 / Opus 4.8 REJECT `temperature`/`top_p`/`top_k` (400) and
 *    `thinking:{type:'enabled',budget_tokens}` (400) → sanitizeBodyForModel().
 *  - Sonnet 5 uses a new tokenizer (~30% more tokens for the same text) and
 *    runs ADAPTIVE THINKING by default, which spends from max_tokens →
 *    maxTokensHeadroom() scales caller budgets so outputs don't truncate.
 *  - `output_config.effort` (low|medium|high|xhigh|max) is the new
 *    cost/quality lever — callers pass extra.effort, applied here.
 */

const MODEL_UPGRADES = {
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-5',
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-sonnet-4-20250514': 'claude-sonnet-5',
  'claude-opus-4-7': 'claude-opus-4-8',
  'claude-opus-4-6': 'claude-opus-4-8',
  'claude-opus-4-5': 'claude-opus-4-8',
  'claude-opus-4-1': 'claude-opus-4-8',
  'claude-opus-4-20250514': 'claude-opus-4-8',
};

// Kill switch: MODEL_UPGRADE_DISABLED=1 pins the old generation (rollback
// without a deploy revert if the new models misbehave in prod).
function upgradesDisabled() {
  return String(process.env.MODEL_UPGRADE_DISABLED || '') === '1';
}

/** Map a (possibly old-generation) model ID to the current generation. */
function normalizeModel(model) {
  if (!model || typeof model !== 'string') return model;
  if (upgradesDisabled()) return model;
  return MODEL_UPGRADES[model] || model;
}

/** Sonnet 5 / Opus 4.8 / 4.7 / Fable — strict request surface. */
function isFiveFamily(model) {
  return (
    typeof model === 'string' &&
    (model.startsWith('claude-sonnet-5') ||
      model.startsWith('claude-opus-4-8') ||
      model.startsWith('claude-opus-4-7') ||
      model.startsWith('claude-fable-5'))
  );
}

/** Models supporting the `effort` output_config (4.6+ / Sonnet 5 / Fable). */
function supportsEffort(model) {
  return (
    isFiveFamily(model) ||
    (typeof model === 'string' && (model.startsWith('claude-opus-4-6') || model.startsWith('claude-sonnet-4-6')))
  );
}

/** Models supporting web_search_20260209 / web_fetch_20260209 (dynamic filtering, no beta). */
function supportsFilteredWebTools(model) {
  return supportsEffort(model);
}

const VALID_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Strip parameters the 5-family rejects with a 400, and apply thinking/effort
 * config. Mutates and returns `body`.
 *
 * opts.effort   — 'low'|'medium'|'high'|'xhigh'|'max' (validated; ignored on
 *                 models without effort support).
 * opts.thinking — explicit thinking config; 'adaptive' shorthand accepted.
 *                 On Sonnet 5 omitting = adaptive (its default); on Opus 4.8
 *                 omitting = off (matches prior 4.7 behavior).
 */
function sanitizeBodyForModel(body, opts = {}) {
  const model = body.model;
  if (opts.thinking) {
    body.thinking = opts.thinking === 'adaptive' ? { type: 'adaptive' } : opts.thinking;
  }
  if (isFiveFamily(model)) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
    if (body.thinking && body.thinking.type === 'enabled') {
      // budget_tokens is removed on the 5-family — adaptive is the only on-mode.
      body.thinking = { type: 'adaptive' };
    }
  }
  if (opts.effort && VALID_EFFORT.has(opts.effort) && supportsEffort(model)) {
    body.output_config = { ...(body.output_config || {}), effort: opts.effort };
  }
  return body;
}

/**
 * Scale a caller's max_tokens for Sonnet 5's new tokenizer (+~30%) plus
 * adaptive-thinking spend. 1.5× with a 1024 floor, capped at 64k (the
 * non-streaming safe ceiling). Other models pass through unchanged.
 */
function maxTokensHeadroom(model, maxTokens) {
  const n = Number(maxTokens);
  if (!Number.isFinite(n) || n <= 0) return maxTokens;
  if (typeof model === 'string' && model.startsWith('claude-sonnet-5')) {
    return Math.min(64000, Math.max(1024, Math.round(n * 1.5)));
  }
  return maxTokens;
}

module.exports = {
  MODEL_UPGRADES,
  normalizeModel,
  isFiveFamily,
  supportsEffort,
  supportsFilteredWebTools,
  sanitizeBodyForModel,
  maxTokensHeadroom,
};
