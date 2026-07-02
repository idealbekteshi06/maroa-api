'use strict';

/**
 * lib/adBudgetGuard.js
 * ----------------------------------------------------------------------------
 * Plan-aware hard ceiling on Meta/Google/TikTok ad spend.
 *
 * Pre-2026-05-20 audit gap: routes/meta-campaigns.js and routes/google-campaigns.js
 * happily accepted `monthly_budget: 100000` without checking plan tier. A
 * misconfigured customer (or a buggy frontend) could route $100k/mo through
 * Meta with no server-side safety net.
 *
 * Ceilings are intentionally generous — designed to catch runaway typos and
 * automation bugs, not to police real spend. Customers who legitimately need
 * a higher ceiling get it via the Enterprise tier.
 * ----------------------------------------------------------------------------
 */

// Monthly ad-spend ceilings by plan. Numbers are USD.
const CEILINGS = {
  free: 0,
  starter: 1_500, // $50/day — was missing, so paying starter customers fell through to free:0
  growth: 5_000,
  agency: 50_000,
  enterprise: Infinity, // operator-set per contract
};

function ceilingFor(plan) {
  const key = (plan || 'free').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CEILINGS, key)) return CEILINGS[key];
  return CEILINGS.free;
}

/**
 * Validate a requested monthly budget against the business's plan.
 * Returns { ok: true } when allowed, or { ok: false, code, detail, ceiling }
 * when the request exceeds the plan tier or the plan is unknown.
 */
function validateMonthlyBudget({ plan, monthlyBudget }) {
  const n = Number(monthlyBudget);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'INVALID_BUDGET', detail: 'monthly_budget must be a positive number' };
  }
  const ceiling = ceilingFor(plan);
  if (n > ceiling) {
    return {
      ok: false,
      code: 'BUDGET_OVER_PLAN_CEILING',
      detail: `Requested $${n}/mo exceeds the $${ceiling}/mo ceiling for the ${plan || 'free'} plan. Upgrade or set a lower budget.`,
      ceiling,
    };
  }
  return { ok: true, ceiling };
}

module.exports = { validateMonthlyBudget, ceilingFor, CEILINGS };
