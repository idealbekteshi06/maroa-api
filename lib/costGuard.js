'use strict';

/**
 * lib/costGuard.js
 * ----------------------------------------------------------------------------
 * Per-business monthly Anthropic spend cap. Cuts off LLM calls before a
 * single customer can blow our entire Anthropic budget.
 *
 * Reads from `llm_cost_logs` (migration 044) — every Anthropic call writes
 * a cost row with { business_id, model, input_tokens, output_tokens, cost_usd }.
 * We sum the current month's costs per business and compare to a plan-tier cap.
 *
 * Caps mirror PLANS in the frontend repo (src/lib/constants/plans.ts) —
 * keep in sync on every pricing change. Per the May 2026 repositioning,
 * there is no free tier and no starter tier. Legacy DB rows on those
 * tiers are treated as growth (the default).
 *
 * Plan caps (USD/month, LLM cost):
 *   growth      $80    — Sonnet 4.5 default + Opus 4.7 for hard reasoning
 *                        on a single business doing daily content + ad audits
 *   agency      $250   — across all 5 brands combined; Opus 4.7 on every
 *                        strategic call, white-label reports, multi-locale
 *   enterprise  unlimited — handled outside this guard (contract floor)
 *
 * Public API:
 *   checkCostCap({ businessId, sbGet }) → { allowed, used_usd, cap_usd, plan, reason? }
 *   costGuardMiddleware({ sbGet }) — Express middleware enforcement
 *
 * Soft-fail mode: if the llm_cost_logs table doesn't exist OR the lookup
 * fails, we ALLOW the call (don't break Maroa due to telemetry issues).
 * Hard-fail only on confirmed budget overrun.
 *
 * The middleware is per-business keyed — different businesses don't share
 * each other's budget consumption.
 * ----------------------------------------------------------------------------
 */

const PLAN_CAPS_USD = {
  growth: 80,
  agency: 250,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Env override hatch — let ops bump a cap without code change.
// Legacy DB tiers (free/starter) are mapped to growth's cap so old
// accounts don't get a runtime "unknown plan" error pre-migration.
function effectiveCapForPlan(plan) {
  const override = Number(process.env[`COST_CAP_${String(plan || '').toUpperCase()}_USD`]);
  if (Number.isFinite(override) && override > 0) return override;
  return PLAN_CAPS_USD[plan] ?? PLAN_CAPS_USD.growth;
}

/**
 * Check if a business is within budget for the current calendar month.
 * Returns { allowed: bool, ... } — never throws on telemetry failure.
 */
async function checkCostCap({ businessId, sbGet }) {
  if (!businessId || !sbGet) {
    return { allowed: true, reason: 'no businessId or sbGet — soft-allow', soft_fail: true };
  }
  // Reject non-UUIDs at the door — never let them touch the PostgREST filter.
  // We hard-fail here (not soft-allow) because a malformed businessId means
  // somebody is probing the API and we should not give them a free pass.
  if (!isUuid(businessId)) {
    return { allowed: false, reason: 'invalid_business_id', soft_fail: false };
  }
  const safeBiz = encodeURIComponent(businessId);
  try {
    // Read plan tier (so we know the cap)
    const bizRows = await sbGet('businesses', `id=eq.${safeBiz}&select=plan`).catch(() => []);
    // Default to growth for legacy "free"/"starter" rows that pre-date
    // the May 2026 pricing reset. The frontend signup now writes the
    // selected paid plan; this fallback is only for migration safety.
    const plan = bizRows?.[0]?.plan || 'growth';
    const cap = effectiveCapForPlan(plan);

    // Sum costs since start of current calendar month UTC
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const sinceISO = monthStart.toISOString();

    const rows = await sbGet(
      'llm_cost_logs',
      `business_id=eq.${safeBiz}&created_at=gte.${encodeURIComponent(sinceISO)}&select=cost_usd&limit=10000`
    ).catch(() => null);

    // Soft-fail if telemetry table unavailable
    if (rows === null) {
      return { allowed: true, reason: 'cost log table unreachable — soft-allow', soft_fail: true, plan, cap_usd: cap };
    }

    const usedUsd = rows.reduce((acc, r) => acc + (Number(r.cost_usd) || 0), 0);
    const allowed = usedUsd < cap;
    return {
      allowed,
      plan,
      used_usd: Math.round(usedUsd * 10000) / 10000,
      cap_usd: cap,
      remaining_usd: Math.max(0, cap - usedUsd),
      reason: allowed ? null : `monthly_cap_reached`,
    };
  } catch (e) {
    return { allowed: true, reason: `cost_guard_error_soft_allow: ${e.message}`, soft_fail: true };
  }
}

/**
 * Express middleware. Reads businessId from body/query/params, checks
 * the cap, returns HTTP 402 (Payment Required) if exceeded.
 *
 * Honest tradeoff: this adds 1 DB roundtrip per gated request. We mount
 * it ONLY on expensive LLM endpoints, not on every webhook. Cheap reads
 * like /webhook/cron-health stay un-gated.
 */
function costGuardMiddleware({ sbGet }) {
  return async function costGuard(req, res, next) {
    const businessId =
      req.body?.businessId ||
      req.body?.business_id ||
      req.query?.businessId ||
      req.query?.business_id ||
      req.params?.businessId;
    if (!businessId) return next(); // no biz id → out of scope for this guard

    const verdict = await checkCostCap({ businessId, sbGet });
    if (!verdict.allowed) {
      return res.status(402).json({
        error: {
          code: 'COST_CAP_REACHED',
          message: `This business has reached its monthly LLM budget cap`,
          details: {
            plan: verdict.plan,
            used_usd: verdict.used_usd,
            cap_usd: verdict.cap_usd,
            request_id: req.requestId,
          },
        },
      });
    }
    // Attach verdict to req so downstream handlers can know remaining budget
    req.costGuard = verdict;
    next();
  };
}

module.exports = {
  checkCostCap,
  costGuardMiddleware,
  effectiveCapForPlan,
  PLAN_CAPS_USD,
};
