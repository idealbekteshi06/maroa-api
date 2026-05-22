'use strict';

/**
 * lib/webSearchGate.js — per-business monthly Anthropic web search caps.
 * Counts llm_cost_logs rows with skill=web_search (one row ≈ one search unit).
 */

const MONTHLY_CAPS = {
  free: 0,
  starter: 0,
  growth: 25,
  agency: 100,
};

const SEARCH_UNIT_USD = 0.01; // $10 / 1k searches

function capForPlan(plan) {
  const p = String(plan || 'starter').toLowerCase();
  return MONTHLY_CAPS[p] ?? MONTHLY_CAPS.starter;
}

async function countMonthlySearches(sbGet, businessId) {
  if (!sbGet || !businessId) return 0;
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const safe = encodeURIComponent(businessId);
  const rows = await sbGet(
    'llm_cost_logs',
    `business_id=eq.${safe}&skill=eq.web_search&created_at=gte.${encodeURIComponent(since.toISOString())}&select=id&limit=10000`
  ).catch(() => []);
  return rows.length;
}

async function checkWebSearchBudget({ businessId, sbGet, plan }) {
  const cap = capForPlan(plan);
  if (!cap) return { allowed: false, reason: 'plan_no_web_search', cap: 0, used: 0 };
  const used = await countMonthlySearches(sbGet, businessId);
  if (used >= cap) {
    return { allowed: false, reason: 'monthly_web_search_cap', cap, used };
  }
  return { allowed: true, cap, used, remaining: cap - used };
}

async function recordWebSearchUse({ businessId, count = 1, sbPost, logger }) {
  if (!sbPost || !businessId || count < 1) return;
  for (let i = 0; i < count; i++) {
    try {
      await sbPost('llm_cost_logs', {
        business_id: businessId,
        skill: 'web_search',
        model: 'web_search_tool',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: Number(SEARCH_UNIT_USD.toFixed(4)),
      });
    } catch (e) {
      logger?.warn?.('webSearchGate', businessId, 'record failed', { error: e.message });
    }
  }
}

module.exports = {
  MONTHLY_CAPS,
  SEARCH_UNIT_USD,
  capForPlan,
  checkWebSearchBudget,
  recordWebSearchUse,
  countMonthlySearches,
};
