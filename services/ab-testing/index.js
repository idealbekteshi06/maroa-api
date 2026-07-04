'use strict';

/**
 * services/ab-testing/index.js — creative A/B experiments engine (2026-07).
 *
 * "Test two creatives scientifically" instead of eyeballing CTR. Each
 * experiment pins two variants (each referencing a campaign whose dailies
 * land in ad_performance_logs), accumulates impressions/clicks/conversions
 * per arm, and runs a TWO-PROPORTION Z-TEST:
 *
 *   - winner declared only at p < 0.05 AND both arms ≥ min_impressions_per_arm
 *   - 'no_difference' declared once both arms have 4× the minimum sample and
 *     the test still isn't significant (stops zombie experiments)
 *   - otherwise 'collecting', with per-arm progress
 *
 * The engine RECOMMENDS — it never pauses/kills ads itself; execution stays
 * with the ad-optimizer's gated actuator (same philosophy as decision vs.
 * execution split there). Statistical core is pure + fully unit-tested.
 *
 * DI factory — deps: { sbGet, sbPost, sbPatch, logger }.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// ─── Statistics (pure) ─────────────────────────────────────────────────────

/** Abramowitz–Stegun erf approximation (max error ~1.5e-7). */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Two-tailed p-value for a standard normal z statistic. */
function pValueTwoTailed(z) {
  return Math.max(0, Math.min(1, 1 - erf(Math.abs(z) / Math.SQRT2)));
}

/**
 * Two-proportion z-test (pooled). successes/trials per arm.
 * Returns { ok, z, pValue, rateA, rateB, lift } — lift is B-relative-to-A.
 */
function twoProportionZTest({ aSuccess, aTrials, bSuccess, bTrials }) {
  const a = Number(aSuccess) || 0;
  const na = Number(aTrials) || 0;
  const b = Number(bSuccess) || 0;
  const nb = Number(bTrials) || 0;
  if (na <= 0 || nb <= 0) return { ok: false, reason: 'no_trials' };
  const pA = a / na;
  const pB = b / nb;
  const pooled = (a + b) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (!Number.isFinite(se) || se === 0) {
    // Both arms 0% or 100% — no discriminating information.
    return { ok: true, z: 0, pValue: 1, rateA: pA, rateB: pB, lift: 0 };
  }
  const z = (pB - pA) / se;
  return {
    ok: true,
    z: Math.round(z * 10000) / 10000,
    pValue: Math.round(pValueTwoTailed(z) * 100000) / 100000,
    rateA: pA,
    rateB: pB,
    lift: pA > 0 ? Math.round(((pB - pA) / pA) * 10000) / 10000 : null,
  };
}

module.exports = function createAbTesting(deps = {}) {
  const { sbGet, sbPost, sbPatch, logger } = deps;

  const SIGNIFICANCE = 0.05;
  const FUTILITY_MULTIPLIER = 4; // both arms at 4× min sample + still p≥0.05 → no_difference

  function _variantShape(v, label) {
    if (!v || typeof v !== 'object') throw new Error(`variant_${label} object required`);
    if (!isUuid(v.campaign_id)) throw new Error(`variant_${label}.campaign_id (UUID) required`);
    return {
      campaign_id: v.campaign_id,
      label: String(v.label || label.toUpperCase()).slice(0, 120),
      creative_ref: typeof v.creative_ref === 'string' ? v.creative_ref.slice(0, 300) : null,
    };
  }

  async function createExperiment({
    businessId,
    name,
    metric = 'ctr',
    minImpressionsPerArm = 1000,
    variantA,
    variantB,
  }) {
    if (!isUuid(businessId)) throw new Error('businessId (UUID) required');
    if (!['ctr', 'conversion_rate'].includes(metric)) throw new Error('metric must be ctr | conversion_rate');
    const row = await sbPost('ab_tests', {
      business_id: businessId,
      name: String(name || 'Creative A/B test').slice(0, 200),
      metric,
      min_impressions_per_arm: Math.min(Math.max(100, Number(minImpressionsPerArm) || 1000), 1000000),
      variant_a: _variantShape(variantA, 'a'),
      variant_b: _variantShape(variantB, 'b'),
      status: 'collecting',
      result: {},
    });
    logger?.info?.('/ab-testing', businessId, `experiment created ${row?.id}`, { metric });
    return row;
  }

  /** Sum an arm's trials/successes from ad_performance_logs since the experiment started. */
  async function _armTotals({ businessId, campaignId, metric, since }) {
    const rows = await sbGet(
      'ad_performance_logs',
      `business_id=eq.${encodeURIComponent(businessId)}&campaign_id=eq.${encodeURIComponent(campaignId)}` +
        `&logged_at=gte.${encodeURIComponent(since)}&select=impressions,clicks,conversions&limit=1000`
    ).catch(() => []);
    let impressions = 0;
    let clicks = 0;
    let conversions = 0;
    for (const r of rows || []) {
      impressions += Number(r.impressions) || 0;
      clicks += Number(r.clicks) || 0;
      conversions += Number(r.conversions) || 0;
    }
    const success = metric === 'conversion_rate' ? conversions : clicks;
    // conversion_rate uses clicks as trials (conv per click); ctr uses impressions.
    const trials = metric === 'conversion_rate' ? clicks : impressions;
    return { impressions, clicks, conversions, success, trials };
  }

  /**
   * Evaluate an experiment. Returns the updated row-shaped verdict and
   * persists it. Never throws for data gaps — reports 'collecting'.
   */
  async function evaluateExperiment({ experimentId, businessId }) {
    if (!isUuid(experimentId) || !isUuid(businessId)) throw new Error('experimentId + businessId (UUIDs) required');
    const rows = await sbGet(
      'ab_tests',
      `id=eq.${encodeURIComponent(experimentId)}&business_id=eq.${encodeURIComponent(businessId)}&select=*&limit=1`
    ).catch(() => []);
    const exp = rows?.[0];
    if (!exp) return { ok: false, reason: 'experiment_not_found' };
    if (exp.status !== 'collecting') {
      return { ok: true, status: exp.status, result: exp.result, confidence: exp.confidence, already_concluded: true };
    }

    const since = exp.tested_at || exp.created_at || new Date(0).toISOString();
    const metric = exp.metric || 'ctr';
    const [armA, armB] = await Promise.all([
      _armTotals({ businessId, campaignId: exp.variant_a?.campaign_id, metric, since }),
      _armTotals({ businessId, campaignId: exp.variant_b?.campaign_id, metric, since }),
    ]);

    const minArm = Number(exp.min_impressions_per_arm) || 1000;
    const progress = {
      metric,
      arm_a: armA,
      arm_b: armB,
      min_impressions_per_arm: minArm,
    };

    if (armA.impressions < minArm || armB.impressions < minArm) {
      const result = {
        ...progress,
        verdict: 'collecting',
        detail: `Need ≥${minArm} impressions per arm (A: ${armA.impressions}, B: ${armB.impressions})`,
      };
      await sbPatch('ab_tests', `id=eq.${encodeURIComponent(experimentId)}`, { result }).catch(() => {});
      return { ok: true, status: 'collecting', result };
    }

    const testR = twoProportionZTest({
      aSuccess: armA.success,
      aTrials: armA.trials,
      bSuccess: armB.success,
      bTrials: armB.trials,
    });
    if (!testR.ok) {
      const result = { ...progress, verdict: 'collecting', detail: 'No trials recorded yet for one arm' };
      await sbPatch('ab_tests', `id=eq.${encodeURIComponent(experimentId)}`, { result }).catch(() => {});
      return { ok: true, status: 'collecting', result };
    }

    let status = 'collecting';
    let winner = null;
    if (testR.pValue < SIGNIFICANCE) {
      winner = testR.rateB > testR.rateA ? 'b' : 'a';
      status = winner === 'a' ? 'winner_a' : 'winner_b';
    } else if (armA.impressions >= minArm * FUTILITY_MULTIPLIER && armB.impressions >= minArm * FUTILITY_MULTIPLIER) {
      status = 'no_difference';
    }

    const confidence = Math.round((1 - testR.pValue) * 10000) / 10000;
    const result = {
      ...progress,
      verdict: status,
      z: testR.z,
      p_value: testR.pValue,
      rate_a: testR.rateA,
      rate_b: testR.rateB,
      lift_b_vs_a: testR.lift,
      recommendation:
        status === 'winner_a'
          ? `Variant A (${exp.variant_a?.label || 'A'}) wins — shift budget to it.`
          : status === 'winner_b'
            ? `Variant B (${exp.variant_b?.label || 'B'}) wins — shift budget to it.`
            : status === 'no_difference'
              ? 'No meaningful difference — pick by cost or refresh both creatives.'
              : 'Keep collecting data.',
    };

    const patch = { result, confidence };
    if (status !== 'collecting') {
      patch.status = status;
      patch.winner = winner;
      patch.concluded_at = new Date().toISOString();
    }
    await sbPatch('ab_tests', `id=eq.${encodeURIComponent(experimentId)}`, patch).catch(() => {});
    logger?.info?.('/ab-testing', businessId, `experiment ${experimentId} → ${status}`, {
      p: testR.pValue,
      z: testR.z,
    });
    return { ok: true, status, result, confidence };
  }

  async function listExperiments({ businessId, status }) {
    if (!isUuid(businessId)) throw new Error('businessId (UUID) required');
    const filter =
      `business_id=eq.${encodeURIComponent(businessId)}` +
      (status ? `&status=eq.${encodeURIComponent(status)}` : '') +
      '&order=tested_at.desc&limit=50&select=*';
    return sbGet('ab_tests', filter).catch(() => []);
  }

  return {
    createExperiment,
    evaluateExperiment,
    listExperiments,
    // exported for tests + reuse
    twoProportionZTest,
    pValueTwoTailed,
    erf,
  };
};
