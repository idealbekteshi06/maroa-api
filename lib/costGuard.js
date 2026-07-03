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
 * Plan caps (USD/month, LLM cost) — aligned with /api/billing/plans:
 *   starter     $30    — $25/mo list · 1 platform, lighter AI brain cadence
 *   growth      $80    — $59/mo · daily content + ad audits + competitor intel
 *   agency      $250   — $99/mo · multi-brand, white-label, strategic Opus calls
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
  starter: 30,
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
  if (plan === 'free') return PLAN_CAPS_USD.starter;
  // Unknown/missing plan → cheapest cap (fail-safe). Defaulting to growth let a
  // typo'd or capitalized plan string ('Growth', legacy tiers) silently receive
  // the $80 cap; the safe direction is the most restrictive tier.
  return PLAN_CAPS_USD[plan] ?? PLAN_CAPS_USD.starter;
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
    // Read plan tier (so we know the cap). Distinguish a genuine "row missing"
    // (→ cheapest cap, fail-safe for legacy rows) from a DB read FAILURE. On a
    // read failure we must NOT downgrade a paying customer to the starter cap
    // and block them — a Supabase blip would otherwise reject a growth/agency
    // customer's legitimate call. Soft-allow instead, consistent with the
    // cost-log read soft-fail below.
    let bizRows;
    try {
      bizRows = await sbGet('businesses', `id=eq.${safeBiz}&select=plan`);
    } catch (e) {
      return { allowed: true, reason: 'plan_lookup_failed_soft_allow', soft_fail: true, error: e?.message };
    }
    // Missing plan → cheapest cap (fail-safe). The frontend signup writes the
    // selected paid plan; this fallback only covers legacy/unknown rows.
    const plan = bizRows?.[0]?.plan || 'starter';
    const cap = effectiveCapForPlan(plan);

    // Sum costs since start of current calendar month UTC.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const sinceISO = monthStart.toISOString();

    // Page through ALL month-to-date rows, summing as we go, and stop as soon
    // as we cross the cap (we only need allowed vs not). The old `limit=10000`
    // single fetch silently capped the sum, so any business past 10k cost rows
    // in a month got effectively unlimited spend. Early-exit bounds the cost
    // for over-budget accounts; MAX_PAGES is a hard safety ceiling.
    const PAGE = 1000;
    const MAX_PAGES = 200; // 200k rows/month ceiling
    let usedUsd = 0;
    let offset = 0;
    let pages = 0;
    let tableUnreachable = false;
    let overCap = false;
    for (; pages < MAX_PAGES; pages += 1) {
      const page = await sbGet(
        'llm_cost_logs',
        `business_id=eq.${safeBiz}&created_at=gte.${encodeURIComponent(sinceISO)}&select=cost_usd&order=created_at.asc&limit=${PAGE}&offset=${offset}`
      ).catch(() => null);
      if (page === null) {
        tableUnreachable = true;
        break;
      }
      for (const r of page) usedUsd += Number(r.cost_usd) || 0;
      if (usedUsd >= cap) {
        overCap = true;
        break;
      }
      if (page.length < PAGE) break; // exhausted
      offset += PAGE;
    }

    // Soft-fail only if the very first page was unreachable (telemetry down).
    if (tableUnreachable && usedUsd === 0) {
      return { allowed: true, reason: 'cost log table unreachable — soft-allow', soft_fail: true, plan, cap_usd: cap };
    }

    const allowed = !overCap && usedUsd < cap;
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
