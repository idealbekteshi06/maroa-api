'use strict';

/**
 * services/prompts/forecasting/regression.js
 * ----------------------------------------------------------------------------
 * Pure-deterministic forecasting math. No LLM here. The LLM only narrates the
 * numbers — it never invents them.
 *
 * Provides:
 *   linearForecast(timeSeries, horizonDays) → { low, mid, high, slope, intercept }
 *   varianceClass(timeSeries) → 'low' | 'medium' | 'high'
 *   simpleSeasonal(timeSeries, period) → array of seasonal indices
 *   diminishingReturnsCurve(channelData) → optimal allocation
 *   cohortLtv(orders, customers) → average LTV with confidence
 * ----------------------------------------------------------------------------
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function mean(arr) {
  const v = arr.filter(Number.isFinite);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function stddev(arr) {
  const m = mean(arr);
  if (m == null) return null;
  const v = arr.filter(Number.isFinite);
  if (v.length < 2) return 0;
  const sumSq = v.reduce((a, b) => a + (b - m) ** 2, 0);
  return Math.sqrt(sumSq / (v.length - 1));
}

/**
 * Coefficient of variation (CV) — std / mean. Tells us how noisy the data is.
 * CV > 0.6 → high variance → forecast unreliable.
 */
function coefVariation(arr) {
  const m = mean(arr);
  if (m == null || m === 0) return null;
  const sd = stddev(arr);
  if (sd == null) return null;
  return sd / Math.abs(m);
}

function varianceClass(timeSeries) {
  const cv = coefVariation(timeSeries.filter(Number.isFinite));
  if (cv == null) return 'unknown';
  if (cv < 0.25) return 'low';
  if (cv < 0.6)  return 'medium';
  return 'high';
}

/**
 * Linear least-squares regression.
 * Returns slope + intercept + R² (coefficient of determination).
 */
function linearFit(values) {
  const v = values.filter(Number.isFinite);
  const n = v.length;
  if (n < 3) return null;

  const xs = v.map((_, i) => i);
  const meanX = (n - 1) / 2;
  const meanY = v.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, totalSS = 0, residSS = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (v[i] - meanY);
    denX += (xs[i] - meanX) ** 2;
    totalSS += (v[i] - meanY) ** 2;
  }
  if (denX === 0) return null;

  const slope = num / denX;
  const intercept = meanY - slope * meanX;

  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    residSS += (v[i] - predicted) ** 2;
  }
  const r2 = totalSS === 0 ? 0 : Math.max(0, 1 - residSS / totalSS);

  return { slope, intercept, r2, n };
}

/**
 * Forecast a value N steps ahead with confidence interval.
 *
 * Returns { low, mid, high, slope, r2, sample_size, confidence }
 * `confidence` is 'low' | 'medium' | 'high' based on R² and sample size.
 */
function linearForecast(timeSeries, horizonDays) {
  const fit = linearFit(timeSeries);
  if (!fit) return null;
  const { slope, intercept, r2, n } = fit;

  // Project forward
  const futureX = n - 1 + horizonDays;
  const mid = slope * futureX + intercept;

  // Residual std-dev defines the confidence band
  const residuals = timeSeries
    .filter(Number.isFinite)
    .map((v, i) => v - (slope * i + intercept));
  const residSd = stddev(residuals) || 0;

  // Confidence band widens with horizon (sqrt of horizon = standard practice)
  const horizonScale = Math.sqrt(1 + horizonDays / Math.max(1, n));
  const band = 1.96 * residSd * horizonScale; // ~95% CI

  let confidence = 'medium';
  if (r2 > 0.6 && n >= 14) confidence = 'high';
  else if (r2 < 0.2 || n < 7) confidence = 'low';

  return {
    low:  Math.max(0, mid - band),
    mid:  Math.max(0, mid),
    high: Math.max(0, mid + band),
    slope,
    intercept,
    r2,
    sample_size: n,
    confidence,
  };
}

/**
 * Apply a diminishing-returns model across channels.
 * Each channel has { spend, conversions, roas }. We assume each $1 added beyond
 * the current spend has slightly lower marginal ROAS. The function returns the
 * recommended allocation that maximizes expected total revenue at the same
 * total spend.
 *
 * Simple model: marginal_roas(channel, extra_spend) = roas * exp(-extra_spend / scale)
 *   where scale = current_spend (so doubling current spend cuts marginal in half)
 *
 * This is intentionally conservative — won't recommend wild reallocations.
 */
function recommendBudgetAllocation(channels) {
  if (!Array.isArray(channels) || channels.length < 2) return null;
  const valid = channels.filter(c =>
    Number.isFinite(Number(c.spend)) && Number(c.spend) > 0 &&
    Number.isFinite(Number(c.roas)) && Number(c.roas) > 0
  );
  if (valid.length < 2) return null;

  const totalSpend = valid.reduce((a, c) => a + Number(c.spend), 0);
  if (totalSpend === 0) return null;

  // Compute marginal-ROAS at current point for each channel
  // Then simulate moving small chunks (5% of total) toward higher-marginal channel
  const allocation = valid.map(c => ({ name: c.name, spend: Number(c.spend), roas: Number(c.roas), scale: Number(c.spend) }));

  const stepSize = totalSpend * 0.02; // 2% chunks
  const steps = 25; // ~50% redistribution max

  for (let step = 0; step < steps; step++) {
    // Marginal ROAS for each channel at current allocation
    const marginals = allocation.map(c => {
      const extra = c.spend - c.scale;
      const marginal = c.roas * Math.exp(-extra / Math.max(1, c.scale));
      return { name: c.name, marginal };
    });

    // Find highest-marginal and lowest-marginal
    const highest = marginals.reduce((a, b) => a.marginal > b.marginal ? a : b);
    const lowest  = marginals.reduce((a, b) => a.marginal < b.marginal ? a : b);
    if (highest.marginal - lowest.marginal < 0.05) break; // converged

    // Move stepSize from lowest to highest, but never below 10% of original
    const lowChannel = allocation.find(c => c.name === lowest.name);
    const highChannel = allocation.find(c => c.name === highest.name);
    if (lowChannel.spend - stepSize < lowChannel.scale * 0.10) break;
    lowChannel.spend  -= stepSize;
    highChannel.spend += stepSize;
  }

  // Expected lift: conservative estimate at HALF of perfect-linear lift to
  // account for diminishing returns we can't measure exactly.
  let currentRevenue = 0, linearNewRevenue = 0;
  for (const c of valid)      currentRevenue   += c.spend * c.roas;
  for (const c of allocation) linearNewRevenue += c.spend * c.roas;
  const linearLift = currentRevenue > 0 ? (linearNewRevenue - currentRevenue) / currentRevenue : null;
  const liftPct = linearLift != null ? Math.max(0, linearLift * 0.5) : null;

  return {
    current: Object.fromEntries(valid.map(c => [c.name, Number(c.spend)])),
    recommended: Object.fromEntries(allocation.map(c => [c.name, Number(c.spend.toFixed(2))])),
    expected_lift_pct: liftPct != null ? Number(liftPct.toFixed(3)) : null,
  };
}

/**
 * Cohort LTV calculation. Inputs:
 *   orders: [{ customer_id, amount, ordered_at }]
 *
 * Returns { value, confidence, sample_size, repeat_rate } or null if insufficient.
 */
function cohortLtv(orders) {
  if (!Array.isArray(orders) || orders.length < 10) return null;

  const byCustomer = new Map();
  for (const o of orders) {
    if (!o.customer_id) continue;
    const list = byCustomer.get(o.customer_id) || [];
    list.push(o);
    byCustomer.set(o.customer_id, list);
  }

  const customerCount = byCustomer.size;
  if (customerCount < 5) return null;

  const totals = [...byCustomer.values()].map(list =>
    list.reduce((a, o) => a + Number(o.amount || 0), 0)
  );
  const repeatCount = [...byCustomer.values()].filter(list => list.length > 1).length;
  const repeatRate = repeatCount / customerCount;
  const meanLtv = mean(totals);

  let confidence = 'medium';
  if (customerCount > 50 && coefVariation(totals) < 0.6) confidence = 'high';
  else if (customerCount < 15) confidence = 'low';

  return {
    value: meanLtv,
    repeat_rate: repeatRate,
    sample_size: customerCount,
    confidence,
  };
}

module.exports = {
  mean,
  stddev,
  coefVariation,
  varianceClass,
  linearFit,
  linearForecast,
  recommendBudgetAllocation,
  cohortLtv,
};
