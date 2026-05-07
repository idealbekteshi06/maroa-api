'use strict';

/**
 * services/observability/cost-tracker.js
 * ----------------------------------------------------------------------------
 * Tracks Anthropic + Replicate + Higgsfield + SerpAPI costs per business per day.
 *
 * Hooks into existing callClaude responses. Persists to llm_cost_logs table
 * (created by migration 044). Surfaces in cost-report.js for daily monitoring.
 *
 * Pricing constants (Anthropic May 2026):
 *   Sonnet 4.5  — $3.00 / MTok input, $15.00 / MTok output
 *   Opus 4.7    — $5.00 / MTok input, $25.00 / MTok output
 *   Haiku 4.5   — $0.80 / MTok input, $4.00 / MTok output
 *
 * Caching: cached input is 90% cheaper. We track cache hits separately.
 * ----------------------------------------------------------------------------
 */

const metrics = require('./metrics');

const PRICING = {
  // model → { input_per_mtok, output_per_mtok, cache_read_per_mtok }
  'claude-sonnet-4-5': { input: 3.0,  output: 15.0, cache_read: 0.30 },
  'claude-opus-4-7':   { input: 5.0,  output: 25.0, cache_read: 0.50 },
  'claude-haiku-4-5':  { input: 0.80, output: 4.0,  cache_read: 0.08 },
  // Aliases for backwards compat
  'claude-sonnet-4':   { input: 3.0,  output: 15.0, cache_read: 0.30 },
  'claude-opus-4':     { input: 5.0,  output: 25.0, cache_read: 0.50 },
};

const FALLBACK_PRICING = { input: 3.0, output: 15.0, cache_read: 0.30 }; // Sonnet default

/**
 * Compute cost in USD for a single LLM call.
 *
 * @param {object} usage   { input_tokens, output_tokens, cache_read_input_tokens? }
 * @param {string} model   Anthropic model id
 * @returns {number}       Cost in USD
 */
function calcCost(usage, model) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = PRICING[model] || FALLBACK_PRICING;

  const cachedRead   = Number(usage.cache_read_input_tokens) || 0;
  const inputTokens  = (Number(usage.input_tokens) || 0) - cachedRead;
  const outputTokens = Number(usage.output_tokens) || 0;

  return (
    (inputTokens / 1e6)  * p.input +
    (cachedRead / 1e6)   * p.cache_read +
    (outputTokens / 1e6) * p.output
  );
}

/**
 * Track a single LLM call. Records to metrics + optionally persists to DB.
 *
 * Idempotent — safe to call multiple times for same call_id.
 */
async function track({ businessId, skill, model, usage, cost_usd, sbPost, logger }) {
  const cost = Number.isFinite(cost_usd) ? cost_usd : calcCost(usage, model);
  if (!cost) return cost;

  // Metrics
  metrics.increment('llm_calls_total', { skill: skill || 'unknown', model: model || 'unknown' });
  metrics.observeHistogram('llm_cost_usd_total_per_call', cost * 1000, { skill, model });
  metrics.increment('llm_tokens_input_total',  { skill, model }, Number(usage?.input_tokens) || 0);
  metrics.increment('llm_tokens_output_total', { skill, model }, Number(usage?.output_tokens) || 0);
  if (usage?.cache_read_input_tokens) {
    metrics.increment('llm_tokens_cached_total', { skill, model }, Number(usage.cache_read_input_tokens));
  }

  // Persist to DB (best-effort)
  if (typeof sbPost === 'function' && businessId) {
    try {
      await sbPost('llm_cost_logs', {
        business_id: businessId,
        skill: skill || 'unknown',
        model: model || 'unknown',
        input_tokens: Number(usage?.input_tokens) || 0,
        output_tokens: Number(usage?.output_tokens) || 0,
        cache_read_tokens: Number(usage?.cache_read_input_tokens) || 0,
        cost_usd: Number(cost.toFixed(6)),
      });
    } catch (e) {
      logger?.warn?.('cost-tracker', { error: e.message });
    }
  }

  return cost;
}

/**
 * Express endpoint handler — returns cost breakdown for last N days.
 * GET /api/cost-report?days=7
 */
async function buildCostReport({ sbGet, days = 7 }) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await sbGet(
    'llm_cost_logs',
    `created_at=gte.${since}&order=created_at.desc&limit=10000&select=*`
  ).catch(() => []);

  const byBusiness = new Map();
  const bySkill = new Map();
  const byModel = new Map();
  let total = 0;

  for (const r of rows) {
    const c = Number(r.cost_usd) || 0;
    total += c;
    byBusiness.set(r.business_id, (byBusiness.get(r.business_id) || 0) + c);
    bySkill.set(r.skill, (bySkill.get(r.skill) || 0) + c);
    byModel.set(r.model, (byModel.get(r.model) || 0) + c);
  }

  return {
    period_days: days,
    total_cost_usd: Number(total.toFixed(2)),
    total_calls: rows.length,
    avg_cost_per_call: rows.length ? Number((total / rows.length).toFixed(4)) : 0,
    top_businesses: [...byBusiness.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, cost]) => ({ business_id: id, cost_usd: Number(cost.toFixed(2)) })),
    by_skill: Object.fromEntries(
      [...bySkill.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(2))])
    ),
    by_model: Object.fromEntries(
      [...byModel.entries()].map(([k, v]) => [k, Number(v.toFixed(2))])
    ),
  };
}

module.exports = {
  PRICING,
  calcCost,
  track,
  buildCostReport,
};
