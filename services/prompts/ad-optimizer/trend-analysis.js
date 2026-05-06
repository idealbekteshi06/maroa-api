'use strict';

/**
 * services/prompts/ad-optimizer/trend-analysis.js
 * ----------------------------------------------------------------------------
 * Turns the last 14 days of ad_performance_logs into a structured trend
 * summary the LLM can reason over. Avoids point-in-time bias.
 *
 * Also implements anti-thrashing logic: looks at last 7 decisions for THIS
 * campaign and flags when a recommended action would oscillate.
 *
 * Public:
 *   buildTrendSummary(history)            → trend object
 *   detectThrashing(decisionHistory)      → { thrashing: bool, pattern: string }
 *   estimateCreativeFatigueEta(history)   → days to fatigue (or null)
 * ----------------------------------------------------------------------------
 */

function safeMean(arr) {
  const v = arr.filter(Number.isFinite);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function safeSlope(values) {
  // Simple least-squares slope of values vs index, returns slope per step.
  const v = values.filter(Number.isFinite);
  if (v.length < 3) return null;
  const n = v.length;
  const xs = v.map((_, i) => i);
  const meanX = (n - 1) / 2;
  const meanY = v.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (v[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return 0;
  return num / den;
}

/**
 * Build a structured trend object from raw performance history.
 * History rows expected in oldest-first order, each with at least:
 *   { roas, ctr, cpc, frequency, spend, impressions, conversions, logged_at }
 */
function buildTrendSummary(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      sample_size: 0,
      roas_7d: null,
      frequency_trajectory: null,
      spend_velocity: null,
      ctr_trajectory: null,
      creative_fatigue_eta_days: null,
      sample_quality: 'insufficient',
    };
  }

  const recent7  = history.slice(-7);
  const recent3  = history.slice(-3);
  const previous7 = history.slice(-14, -7);

  const meanRoas7  = safeMean(recent7.map(r => Number(r?.roas)));
  const meanRoasP  = safeMean(previous7.map(r => Number(r?.roas)));
  const slopeFreq  = safeSlope(recent7.map(r => Number(r?.frequency)));
  const slopeCtr   = safeSlope(recent7.map(r => Number(r?.ctr)));
  const meanFreq3  = safeMean(recent3.map(r => Number(r?.frequency)));
  const sumSpend   = recent7.map(r => Number(r?.spend) || 0).reduce((a, b) => a + b, 0);
  const meanBudget = safeMean(recent7.map(r => Number(r?.daily_budget)));

  const roas7d =
    meanRoas7 == null || meanRoasP == null ? 'stable'
    : (meanRoas7 - meanRoasP) / Math.max(0.01, meanRoasP) > 0.10 ? 'improving'
    : (meanRoas7 - meanRoasP) / Math.max(0.01, meanRoasP) < -0.10 ? 'declining'
    : 'stable';

  const frequencyTrajectory =
    slopeFreq == null ? 'stable'
    : slopeFreq > 0.15 ? 'escalating'
    : slopeFreq > 0.05 ? 'climbing'
    : 'stable';

  const ctrTrajectory =
    slopeCtr == null ? 'stable'
    : slopeCtr > 0 ? 'rising'
    : slopeCtr < -0.0005 ? 'declining'
    : 'stable';

  const expectedSpend = (meanBudget || 0) * 7;
  const spendVelocity =
    meanBudget == null ? 'on_pace'
    : sumSpend < expectedSpend * 0.7 ? 'under'
    : sumSpend > expectedSpend * 1.05 ? 'over'
    : 'on_pace';

  return {
    sample_size: history.length,
    roas_7d: roas7d,
    roas_mean_7d: meanRoas7,
    roas_mean_prev_7d: meanRoasP,
    frequency_trajectory: frequencyTrajectory,
    frequency_recent_3d: meanFreq3,
    ctr_trajectory: ctrTrajectory,
    spend_velocity: spendVelocity,
    spend_7d: sumSpend,
    expected_spend_7d: expectedSpend,
    creative_fatigue_eta_days: estimateCreativeFatigueEta(history),
    sample_quality: history.length >= 7 ? 'good' : history.length >= 3 ? 'limited' : 'insufficient',
  };
}

/**
 * Estimate days until creative fatigue based on freq trajectory + ctr decline.
 * Returns null if signal isn't strong enough to predict.
 */
function estimateCreativeFatigueEta(history) {
  if (!Array.isArray(history) || history.length < 5) return null;
  const freq = history.map(r => Number(r?.frequency)).filter(Number.isFinite);
  const ctr  = history.map(r => Number(r?.ctr)).filter(Number.isFinite);
  if (freq.length < 5 || ctr.length < 5) return null;
  const slopeFreq = safeSlope(freq);
  const slopeCtr  = safeSlope(ctr);
  const lastFreq  = freq[freq.length - 1];
  if (slopeFreq == null || slopeFreq <= 0) return null;
  if (slopeCtr == null || slopeCtr >= 0) return null; // CTR still healthy
  // Fatigue threshold ~= freq 5.0 (avg). Estimate days to reach.
  const days = Math.max(0, Math.round((5.0 - lastFreq) / Math.max(0.01, slopeFreq)));
  if (days > 60) return null; // too far out, not actionable
  return days;
}

/**
 * Detect anti-thrashing patterns in the recent decision history.
 * decisionHistory: array of { decision, decided_at } in any order.
 * Returns { thrashing: bool, pattern: string|null, last_pause_at, last_unpause_at }.
 */
function detectThrashing(decisionHistory) {
  if (!Array.isArray(decisionHistory) || decisionHistory.length === 0) {
    return { thrashing: false, pattern: null };
  }
  const sorted = [...decisionHistory].sort((a, b) =>
    new Date(b.decided_at || b.created_at || 0) - new Date(a.decided_at || a.created_at || 0)
  );
  const recent = sorted.slice(0, 7).map(d => String(d.decision || '').toLowerCase());

  // Pattern: pause → unpause → pause within 14d
  const pauses = recent.filter(d => d === 'pause').length;
  const scales = recent.filter(d => d === 'scale').length;
  const flips = recent.reduce((acc, d, i) => {
    if (i === 0) return 0;
    const prev = recent[i - 1];
    return acc + ((prev === 'pause' && d !== 'pause') || (prev !== 'pause' && d === 'pause') ? 1 : 0);
  }, 0);

  const lastPause = sorted.find(d => String(d.decision).toLowerCase() === 'pause');
  const lastScale = sorted.find(d => String(d.decision).toLowerCase() === 'scale');

  let pattern = null;
  let thrashing = false;
  if (flips >= 2 && pauses >= 2) {
    pattern = 'pause_unpause_pause';
    thrashing = true;
  } else if (lastPause) {
    const hoursSince = (Date.now() - new Date(lastPause.decided_at || lastPause.created_at || 0)) / 36e5;
    if (hoursSince < 48) {
      pattern = 'recent_pause_within_48h';
      thrashing = true;
    }
  } else if (lastScale && scales >= 2) {
    const hoursSince = (Date.now() - new Date(lastScale.decided_at || lastScale.created_at || 0)) / 36e5;
    if (hoursSince < 72) {
      pattern = 'recent_scale_within_72h';
    }
  }

  return {
    thrashing,
    pattern,
    last_pause_at: lastPause?.decided_at || lastPause?.created_at || null,
    last_scale_at: lastScale?.decided_at || lastScale?.created_at || null,
    flip_count_7decisions: flips,
  };
}

module.exports = {
  buildTrendSummary,
  estimateCreativeFatigueEta,
  detectThrashing,
  safeMean,
  safeSlope,
};
