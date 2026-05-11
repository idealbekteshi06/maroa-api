'use strict';

/**
 * services/ad-optimizer/learning-phase-interlock.js
 * ---------------------------------------------------------------------------
 * Learning-phase interlock — the rule expert media buyers follow that
 * automation tools usually skip:
 *
 *   "No budget change > 20% if the ad set is in learning, OR exited learning
 *    less than 72h ago. No structural edits at all during learning (resets it)."
 *
 * Without this, well-meaning auto-scalers nuke campaigns by re-resetting
 * Meta's learning phase — which costs 50+ conversions of progress to recover.
 *
 * Public API:
 *   canAdjustBudget({ adSet, proposedDelta })
 *     → { allowed, reason, capped_to? }
 *
 *   canEditStructure({ adSet })
 *     → { allowed, reason }
 *
 * `adSet` shape:
 *   { in_learning_phase: bool, exited_learning_at: ISO timestamp | null,
 *     daily_budget: number }
 * ---------------------------------------------------------------------------
 */

const COOLDOWN_HOURS_AFTER_LEARNING = 72;
const MAX_BUDGET_DELTA_PCT_DURING_LEARNING = 0.2; // ±20% absolute cap
const MAX_BUDGET_DELTA_PCT_DURING_COOLDOWN = 0.2;

function hoursSinceISO(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

function canAdjustBudget({ adSet, proposedDelta }) {
  if (!adSet) return { allowed: false, reason: 'No ad set provided' };
  const { in_learning_phase, exited_learning_at } = adSet;
  const hoursSinceExit = hoursSinceISO(exited_learning_at);

  // ── Active learning phase ──
  if (in_learning_phase) {
    if (Math.abs(proposedDelta) > MAX_BUDGET_DELTA_PCT_DURING_LEARNING) {
      return {
        allowed: true,
        capped_to: Math.sign(proposedDelta) * MAX_BUDGET_DELTA_PCT_DURING_LEARNING,
        reason: `In learning phase — capped change to ±${MAX_BUDGET_DELTA_PCT_DURING_LEARNING * 100}% to avoid resetting learning`,
      };
    }
    return {
      allowed: true,
      reason: `In learning phase — ${(proposedDelta * 100).toFixed(0)}% change within ±20% safe band`,
    };
  }

  // ── Cooldown window after exiting learning ──
  if (hoursSinceExit < COOLDOWN_HOURS_AFTER_LEARNING) {
    if (Math.abs(proposedDelta) > MAX_BUDGET_DELTA_PCT_DURING_COOLDOWN) {
      return {
        allowed: true,
        capped_to: Math.sign(proposedDelta) * MAX_BUDGET_DELTA_PCT_DURING_COOLDOWN,
        reason: `Exited learning ${hoursSinceExit.toFixed(0)}h ago (< ${COOLDOWN_HOURS_AFTER_LEARNING}h cooldown) — capped change to ±20%`,
      };
    }
    return { allowed: true, reason: `Within cooldown but change is within safe ±20% band` };
  }

  // ── Past cooldown, normal scaling rules apply ──
  return { allowed: true, reason: 'Past 72h cooldown — full scaling allowed' };
}

function canEditStructure({ adSet }) {
  if (!adSet) return { allowed: false, reason: 'No ad set provided' };
  if (adSet.in_learning_phase) {
    return {
      allowed: false,
      reason:
        'In learning phase — structural edits (audience, placement, optimization goal) reset learning. Wait until ad set exits learning before changing structure.',
    };
  }
  const hoursSinceExit = hoursSinceISO(adSet.exited_learning_at);
  if (hoursSinceExit < COOLDOWN_HOURS_AFTER_LEARNING) {
    return {
      allowed: false,
      reason: `Exited learning only ${hoursSinceExit.toFixed(0)}h ago — wait for full ${COOLDOWN_HOURS_AFTER_LEARNING}h cooldown before structural edits to lock in learnings`,
    };
  }
  return { allowed: true, reason: 'Past cooldown — structural edits OK' };
}

module.exports = {
  canAdjustBudget,
  canEditStructure,
  COOLDOWN_HOURS_AFTER_LEARNING,
  MAX_BUDGET_DELTA_PCT_DURING_LEARNING,
};
