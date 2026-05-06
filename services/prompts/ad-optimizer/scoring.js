'use strict';

/**
 * services/prompts/ad-optimizer/scoring.js
 * ----------------------------------------------------------------------------
 * Weighted health score (0-100) for an ad campaign. Pure-deterministic,
 * computed from findings + raw metrics BEFORE the LLM reasons. The LLM gets
 * the score as a signal, not a thing to invent.
 *
 * The 6 weighted dimensions:
 *   1. Conversion tracking integrity   (20%)
 *   2. Delivery health                 (15%)
 *   3. Audience-creative fit (CTR)     (15%)
 *   4. ROAS / cost efficiency          (25%)
 *   5. Creative freshness              (10%)
 *   6. Compliance + policy             (15%)
 * ----------------------------------------------------------------------------
 */

const DIMENSIONS = {
  conversion_integrity: 0.20,
  delivery:             0.15,
  audience_fit:         0.15,
  cost_efficiency:      0.25,
  creative_freshness:   0.10,
  compliance:           0.15,
};

function clamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }

/**
 * Compute the audit score 0-100 from findings + metrics + market.
 */
function computeAuditScore({ findings, metrics, market, trend }) {
  const sevPenalty = { critical: 25, warning: 10, info: 3 };

  // Conversion integrity ─────────────────────────────────────────────────
  let conversion = 100;
  for (const f of findings) {
    if (f.category === 'conversion') conversion -= sevPenalty[f.severity] ?? 5;
  }
  conversion = clamp(conversion);

  // Delivery ─────────────────────────────────────────────────────────────
  let delivery = 100;
  for (const f of findings) {
    if (f.category === 'delivery') delivery -= sevPenalty[f.severity] ?? 5;
  }
  delivery = clamp(delivery);

  // Audience fit (CTR vs market) ─────────────────────────────────────────
  let audienceFit = 75;
  const ctrPct = (() => {
    const c = Number(metrics?.ctr);
    if (!Number.isFinite(c)) return null;
    return c <= 1 ? c * 100 : c;
  })();
  if (ctrPct != null && market?.healthy_ctr_pct) {
    const ratio = ctrPct / market.healthy_ctr_pct;
    audienceFit = clamp(50 + ratio * 30); // 1.0 ratio → 80; 1.5 ratio → 95
  }
  for (const f of findings) {
    if (f.category === 'audience') audienceFit -= sevPenalty[f.severity] ?? 5;
  }
  audienceFit = clamp(audienceFit);

  // Cost efficiency (ROAS) ───────────────────────────────────────────────
  let cost = 70;
  const roas = Number(metrics?.roas);
  if (Number.isFinite(roas)) {
    if (roas >= 4)      cost = 95;
    else if (roas >= 3) cost = 85;
    else if (roas >= 2) cost = 75;
    else if (roas >= 1.5) cost = 65;
    else if (roas >= 1) cost = 50;
    else if (roas >= 0.5) cost = 30;
    else                cost = 15;
  }
  if (trend?.roas_7d === 'declining') cost -= 10;
  if (trend?.roas_7d === 'improving') cost += 5;
  for (const f of findings) {
    if (f.category === 'budget') cost -= (sevPenalty[f.severity] ?? 5) * 0.5;
  }
  cost = clamp(cost);

  // Creative freshness ───────────────────────────────────────────────────
  let creative = 80;
  if (trend?.frequency_trajectory === 'escalating') creative -= 25;
  if (trend?.frequency_trajectory === 'climbing')   creative -= 10;
  if (trend?.creative_fatigue_eta_days != null && trend.creative_fatigue_eta_days < 7) creative -= 20;
  for (const f of findings) {
    if (f.category === 'creative') creative -= sevPenalty[f.severity] ?? 5;
  }
  creative = clamp(creative);

  // Compliance ───────────────────────────────────────────────────────────
  let compliance = 100;
  for (const f of findings) {
    if (f.category === 'compliance') compliance -= sevPenalty[f.severity] ?? 5;
  }
  compliance = clamp(compliance);

  const dimensions = {
    conversion_integrity: Math.round(conversion),
    delivery: Math.round(delivery),
    audience_fit: Math.round(audienceFit),
    cost_efficiency: Math.round(cost),
    creative_freshness: Math.round(creative),
    compliance: Math.round(compliance),
  };

  const weighted =
      dimensions.conversion_integrity * DIMENSIONS.conversion_integrity
    + dimensions.delivery * DIMENSIONS.delivery
    + dimensions.audience_fit * DIMENSIONS.audience_fit
    + dimensions.cost_efficiency * DIMENSIONS.cost_efficiency
    + dimensions.creative_freshness * DIMENSIONS.creative_freshness
    + dimensions.compliance * DIMENSIONS.compliance;

  return {
    score: Math.round(clamp(weighted)),
    dimensions,
  };
}

module.exports = {
  DIMENSIONS,
  computeAuditScore,
};
