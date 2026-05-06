'use strict';

/**
 * services/prompts/ad-optimizer/budget-calibration.js
 * ----------------------------------------------------------------------------
 * Small-budget calibration — most ad-audit logic in the wild assumes
 * enterprise spend ($1000+/day). Maroa customers run $5-50/day. The same
 * thresholds destroy small budgets.
 *
 * This module:
 *   - Defines spend-tier bands (micro / small / mid / scale / enterprise)
 *   - Provides statistical-significance gates (don't act on noise)
 *   - Provides Meta learning-phase rules
 *   - Suggests budget-change increments that respect learning
 * ----------------------------------------------------------------------------
 */

// --- Spend tiers (USD-equivalent daily) ---
// Each tier has its own thresholds for what counts as significant data.
// Numbers are calibrated to real Meta SMB campaigns, not hypothetical.

const SPEND_TIERS = {
  MICRO: {
    range_usd_daily: [0, 7],
    min_clicks_for_decision: 50,
    min_spend_usd_for_pause: 20,
    min_conversions_for_roas_call: 3,
    significant_ctr_change_pct: 0.4,    // 0.4 percentage points
    safe_budget_increase_pct: 15,
    safe_budget_decrease_pct: 20,
    learning_phase_conversions: 50,     // Meta default — same for everyone
    creative_fatigue_freq: 4.5,
  },
  SMALL: {
    range_usd_daily: [7, 25],
    min_clicks_for_decision: 100,
    min_spend_usd_for_pause: 50,
    min_conversions_for_roas_call: 5,
    significant_ctr_change_pct: 0.3,
    safe_budget_increase_pct: 20,
    safe_budget_decrease_pct: 25,
    learning_phase_conversions: 50,
    creative_fatigue_freq: 4.0,
  },
  MID: {
    range_usd_daily: [25, 100],
    min_clicks_for_decision: 200,
    min_spend_usd_for_pause: 150,
    min_conversions_for_roas_call: 10,
    significant_ctr_change_pct: 0.25,
    safe_budget_increase_pct: 20,
    safe_budget_decrease_pct: 30,
    learning_phase_conversions: 50,
    creative_fatigue_freq: 3.5,
  },
  SCALE: {
    range_usd_daily: [100, 500],
    min_clicks_for_decision: 500,
    min_spend_usd_for_pause: 400,
    min_conversions_for_roas_call: 20,
    significant_ctr_change_pct: 0.2,
    safe_budget_increase_pct: 30,
    safe_budget_decrease_pct: 40,
    learning_phase_conversions: 50,
    creative_fatigue_freq: 3.0,
  },
  ENTERPRISE: {
    range_usd_daily: [500, 999999],
    min_clicks_for_decision: 1000,
    min_spend_usd_for_pause: 1500,
    min_conversions_for_roas_call: 30,
    significant_ctr_change_pct: 0.15,
    safe_budget_increase_pct: 40,
    safe_budget_decrease_pct: 50,
    learning_phase_conversions: 50,
    creative_fatigue_freq: 2.5,
  },
};

/**
 * Pick the spend tier for a daily-budget USD value.
 */
function tierForDailyBudgetUsd(usd) {
  if (!Number.isFinite(usd) || usd < 0) return SPEND_TIERS.MICRO;
  for (const [_, tier] of Object.entries(SPEND_TIERS)) {
    if (usd >= tier.range_usd_daily[0] && usd < tier.range_usd_daily[1]) return tier;
  }
  return SPEND_TIERS.ENTERPRISE;
}

/**
 * Gate: is the data significant enough to recommend pause?
 * Returns { significant: boolean, reason: string }.
 * Used to short-circuit the audit before the LLM ever runs — saves cost AND
 * prevents premature pauses.
 */
function isPauseDataSignificant({ clicks, spend_usd, conversions, daily_budget_usd }) {
  const tier = tierForDailyBudgetUsd(daily_budget_usd);
  if (!Number.isFinite(clicks) || clicks < tier.min_clicks_for_decision) {
    return {
      significant: false,
      reason: `under-powered: ${clicks ?? 0} clicks < ${tier.min_clicks_for_decision} threshold for ${tier.range_usd_daily[0]}-${tier.range_usd_daily[1]} daily-budget tier`,
      tier_name: tierName(tier),
    };
  }
  if (Number.isFinite(spend_usd) && spend_usd < tier.min_spend_usd_for_pause) {
    return {
      significant: false,
      reason: `under-spent: $${spend_usd.toFixed(2)} < $${tier.min_spend_usd_for_pause} pause-threshold for tier`,
      tier_name: tierName(tier),
    };
  }
  return { significant: true, tier_name: tierName(tier) };
}

/**
 * Gate: is ROAS reading reliable?
 * Below conversion threshold, ROAS swings wildly and is NOT a decision basis.
 */
function isRoasReliable({ conversions, daily_budget_usd }) {
  const tier = tierForDailyBudgetUsd(daily_budget_usd);
  if (!Number.isFinite(conversions) || conversions < tier.min_conversions_for_roas_call) {
    return {
      reliable: false,
      reason: `${conversions ?? 0} conversions < ${tier.min_conversions_for_roas_call} required for ROAS-based decisions`,
      tier_name: tierName(tier),
    };
  }
  return { reliable: true, tier_name: tierName(tier) };
}

/**
 * Meta learning-phase respect.
 * Returns whether we're in learning phase + what's allowed.
 */
function evaluateLearningPhase({ conversions_since_edit, days_since_edit, learning_phase_state }) {
  // If platform tells us state directly, trust it.
  if (learning_phase_state) {
    const s = String(learning_phase_state).toLowerCase();
    if (s === 'learning' || s === 'learning_limited') {
      return {
        in_learning: true,
        allow_pause: false,
        max_budget_change_pct: 20,
        guidance: `Campaign in ${s} phase — protect from edits >20% to avoid resetting learning`,
      };
    }
  }
  // Heuristic fallback: Meta needs ~50 conversions in a 7-day window post-edit.
  const c = Number(conversions_since_edit || 0);
  const d = Number(days_since_edit || 0);
  if (c < 50 && d < 7) {
    return {
      in_learning: true,
      allow_pause: false,
      max_budget_change_pct: 20,
      guidance: 'Heuristic: <50 conversions in <7 days post-edit — likely still in learning phase',
    };
  }
  return { in_learning: false, allow_pause: true, max_budget_change_pct: 50, guidance: null };
}

/**
 * Suggest a budget-change amount that respects learning + tier rules.
 * direction: 'up' | 'down'
 */
function safeBudgetChange({ daily_budget_usd, direction, learning_phase_state }) {
  const tier = tierForDailyBudgetUsd(daily_budget_usd);
  const learning = evaluateLearningPhase({ learning_phase_state });
  const cap = learning.in_learning
    ? Math.min(tier.safe_budget_increase_pct, learning.max_budget_change_pct)
    : tier.safe_budget_increase_pct;
  const pct = direction === 'down'
    ? -1 * Math.min(tier.safe_budget_decrease_pct, learning.max_budget_change_pct)
    : cap;
  const newBudgetUsd = daily_budget_usd * (1 + pct / 100);
  return {
    pct_change: pct,
    new_daily_budget_usd: Number(newBudgetUsd.toFixed(2)),
    rationale: learning.in_learning
      ? `respecting learning phase (max ±20%) and ${tierName(tier)} tier (${tier.safe_budget_increase_pct}% inc / ${tier.safe_budget_decrease_pct}% dec)`
      : `${tierName(tier)} tier safe-change limits (${tier.safe_budget_increase_pct}% inc / ${tier.safe_budget_decrease_pct}% dec)`,
  };
}

/** Helper — get the tier name string from a tier object. */
function tierName(tier) {
  for (const [name, t] of Object.entries(SPEND_TIERS)) {
    if (t === tier) return name;
  }
  return 'UNKNOWN';
}

module.exports = {
  SPEND_TIERS,
  tierForDailyBudgetUsd,
  isPauseDataSignificant,
  isRoasReliable,
  evaluateLearningPhase,
  safeBudgetChange,
  tierName,
};
