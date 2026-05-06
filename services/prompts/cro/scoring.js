'use strict';

/**
 * services/prompts/cro/scoring.js
 * ----------------------------------------------------------------------------
 * Weighted health score across 7 CRO dimensions.
 * ----------------------------------------------------------------------------
 */

const DIMENSIONS = {
  above_the_fold: 0.20,
  value_prop:     0.15,
  primary_cta:    0.20,
  social_proof:   0.10,
  trust:          0.15,
  friction:       0.15,
  mobile:         0.05,
};

function clamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }

function computeScore({ findings }) {
  const dims = {
    above_the_fold: 100, value_prop: 100, primary_cta: 100,
    social_proof: 100, trust: 100, friction: 100, mobile: 100,
  };
  const sevPenalty = { critical: 30, warning: 12, info: 4 };
  for (const f of findings || []) {
    if (dims[f.dimension] != null) {
      dims[f.dimension] = clamp(dims[f.dimension] - (sevPenalty[f.severity] || 5));
    }
  }
  let weighted = 0;
  for (const [k, w] of Object.entries(DIMENSIONS)) {
    weighted += (dims[k] || 0) * w;
  }
  return {
    score: Math.round(clamp(weighted)),
    dimensions: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Math.round(v)])),
  };
}

/**
 * Map score → estimated conversion-rate band (rough — for messaging only).
 */
function bandForScore(score) {
  if (score >= 80) return 'strong';
  if (score >= 55) return 'average';
  return 'low';
}

/**
 * Map current score → expected lift band if all critical fixes ship.
 */
function expectedLiftBand({ score, criticalCount }) {
  if (score < 40 && criticalCount >= 3) return 'high';
  if (score < 60 && criticalCount >= 2) return 'medium';
  return 'low';
}

module.exports = { DIMENSIONS, computeScore, bandForScore, expectedLiftBand };
