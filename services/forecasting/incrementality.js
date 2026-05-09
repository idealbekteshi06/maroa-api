'use strict';

/**
 * services/forecasting/incrementality.js
 * ---------------------------------------------------------------------------
 * Incrementality Engine — geo-holdout test design + analysis.
 *
 * Why this exists: Meta + Google + GA4 each over-claim the same conversion.
 * Without incrementality testing, "ROAS 4.0" might really be ROAS 1.5 with
 * 2.5 of organic-or-cross-channel halo. Big budgets are wasted on the
 * difference. Enterprise tools (MMM at $5K+/mo) do this; Maroa replicates
 * the SMB-grade version in-house.
 *
 * Test design:
 *   1. Pick N% of geos (default 10%) as control — pause ads there
 *   2. Run treatment in remaining geos (90%) for 14+ days
 *   3. Compare conversions per capita in treatment vs control
 *   4. Lift = (treatment - control) / control
 *   5. True incremental ROAS = (treatment_conversions - control_conversions) × AOV / treatment_spend
 *
 * Public API:
 *   designTest({ businessId, platform, holdoutPct })
 *     → { treatment_geos, control_geos, recommended_duration_days }
 *
 *   analyzeResults({ test, observations })
 *     → { incremental_lift_pct, true_incremental_roas, p_value,
 *         is_statistically_significant }
 * ---------------------------------------------------------------------------
 */

const DEFAULT_HOLDOUT_PCT = 0.10;
const MIN_TEST_DAYS = 14;
const MIN_CONVERSIONS_PER_ARM = 30;     // statistical floor
const SIGNIFICANCE_THRESHOLD = 0.05;    // p < 0.05

/**
 * designTest — splits the business's served geos into treatment + control.
 * Picks the smallest geos to be control so we don't sacrifice scale.
 */
function designTest({ allGeos, holdoutPct = DEFAULT_HOLDOUT_PCT }) {
  if (!Array.isArray(allGeos) || allGeos.length < 4) {
    return {
      ok: false,
      reason: 'Need at least 4 distinct geos to run a meaningful holdout test',
    };
  }
  // Geos can be strings or { name, weight } objects. If weighted, sort
  // ascending by weight and bucket the smallest until we hit holdout%.
  const sorted = [...allGeos].map((g) => (typeof g === 'string' ? { name: g, weight: 1 } : g))
    .sort((a, b) => (a.weight || 0) - (b.weight || 0));
  const totalWeight = sorted.reduce((acc, g) => acc + (g.weight || 1), 0);
  const targetControlWeight = totalWeight * holdoutPct;

  const control = [];
  let weightSoFar = 0;
  for (const g of sorted) {
    if (weightSoFar >= targetControlWeight) break;
    control.push(g.name);
    weightSoFar += g.weight || 1;
  }
  if (control.length === 0) control.push(sorted[0].name);

  const controlSet = new Set(control);
  const treatment = sorted.filter((g) => !controlSet.has(g.name)).map((g) => g.name);

  return {
    ok: true,
    treatment_geos: treatment,
    control_geos: control,
    recommended_duration_days: MIN_TEST_DAYS,
    achieved_holdout_pct: weightSoFar / totalWeight,
  };
}

/**
 * Two-proportion z-test for conversion-rate difference.
 * Returns { z, p_two_sided }.
 */
function twoProportionZTest({ x1, n1, x2, n2 }) {
  if (!n1 || !n2 || x1 < 0 || x2 < 0) return { z: 0, p_two_sided: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p_two_sided: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, p_two_sided: p };
}

/**
 * Standard normal CDF — approximation good enough for sig testing
 * (Abramowitz & Stegun 26.2.17).
 */
function normalCdf(x) {
  if (x < 0) return 1 - normalCdf(-x);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804 * Math.exp(-x * x / 2);
  const prob = d * t * (
    0.31938153 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429)))
  );
  return 1 - prob;
}

/**
 * analyzeResults — given an incrementality_tests row + observed conversions
 * + spend, compute lift, true incremental ROAS, p-value.
 *
 * observations shape:
 *   { treatment: { conversions, spend, audience_size, aov },
 *     control:   { conversions, spend, audience_size, aov } }
 */
function analyzeResults({ test, observations }) {
  if (!observations?.treatment || !observations?.control) {
    return { ok: false, reason: 'observations.treatment + control required' };
  }

  const t = observations.treatment;
  const c = observations.control;

  // Need enough events per arm for meaningful significance
  if ((t.conversions || 0) < MIN_CONVERSIONS_PER_ARM || (c.conversions || 0) < 0) {
    return {
      ok: true,
      status: 'inconclusive',
      reason: `Treatment has ${t.conversions} conversions (need ≥${MIN_CONVERSIONS_PER_ARM}). Run longer.`,
      observations,
    };
  }

  // Per-capita conversion rates
  const treatmentRate = (t.conversions || 0) / Math.max(1, t.audience_size || 1);
  const controlRate = (c.conversions || 0) / Math.max(1, c.audience_size || 1);
  const liftPct = controlRate > 0 ? (treatmentRate - controlRate) / controlRate : null;

  // True incremental ROAS — uses the absolute conversion DELTA
  // scaled to the treatment audience, multiplied by AOV.
  const aov = t.aov || c.aov || 0;
  const incrementalConversions = (t.conversions || 0) -
    Math.round((c.conversions || 0) * (t.audience_size || 1) / Math.max(1, c.audience_size || 1));
  const trueIncrementalRoas = (t.spend || 0) > 0
    ? (incrementalConversions * aov) / t.spend
    : null;

  // Significance test
  const sig = twoProportionZTest({
    x1: t.conversions || 0,
    n1: t.audience_size || 1,
    x2: c.conversions || 0,
    n2: c.audience_size || 1,
  });

  return {
    ok: true,
    status: sig.p_two_sided < SIGNIFICANCE_THRESHOLD ? 'completed' : 'inconclusive',
    treatment_conversion_rate: treatmentRate,
    control_conversion_rate: controlRate,
    incremental_lift_pct: liftPct,
    true_incremental_roas: trueIncrementalRoas,
    platform_claimed_roas: t.spend > 0 ? ((t.conversions || 0) * aov) / t.spend : null,
    z_score: sig.z,
    p_value: sig.p_two_sided,
    is_statistically_significant: sig.p_two_sided < SIGNIFICANCE_THRESHOLD,
    incremental_conversions: incrementalConversions,
  };
}

module.exports = {
  designTest,
  analyzeResults,
  twoProportionZTest,
  normalCdf,
  DEFAULT_HOLDOUT_PCT,
  MIN_TEST_DAYS,
  MIN_CONVERSIONS_PER_ARM,
  SIGNIFICANCE_THRESHOLD,
};
