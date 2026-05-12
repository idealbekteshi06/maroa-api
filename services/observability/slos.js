'use strict';

/**
 * services/observability/slos.js
 * ----------------------------------------------------------------------------
 * Service Level Objectives — declared in code, not spreadsheets.
 *
 * Each SLO has:
 *   - id           short stable name (used in Sentry tags + dashboards)
 *   - description  what we're promising
 *   - target       the threshold (e.g. "99.5% of requests < 800ms")
 *   - window       rolling window the SLO is measured over (always 30d here)
 *   - error_budget how much we can break it before paging
 *
 * Run `getViolations()` once a minute (from server.js healthcheck cycle or
 * cron) to compute live attainment from the metrics registry and fire a
 * Sentry alert when the error budget is exhausted.
 *
 * SLOs are the contract between the system and its users. Top-1% software
 * declares them explicitly, tracks them automatically, and pages on burn-rate
 * — not on individual error events.
 * ----------------------------------------------------------------------------
 */

const Sentry = (() => {
  try {
    return require('@sentry/node');
  } catch {
    return null;
  }
})();

const metrics = require('./metrics');

// ─── SLO catalog ────────────────────────────────────────────────────────────
//
// Numbers tuned to what the system currently delivers. Tighten as we get more
// production data. Loosening an SLO requires a code change — visible in PR
// review — which is intentional.
//
const SLOS = [
  {
    id: 'api_availability',
    description: 'API responds with non-5xx to /healthz + /readyz',
    target: 0.999, // 99.9% over 30 days = 43 minutes/month error budget
    window_days: 30,
    error_budget_minutes: 43,
    metric: 'http_5xx_rate',
    threshold: 0.001,
  },
  {
    id: 'api_latency_p99',
    description: 'Customer-facing API p99 < 800ms',
    target: 0.99, // 99% of measurement windows under threshold
    window_days: 30,
    error_budget_minutes: 432,
    metric: 'http_request_p99_ms',
    threshold: 800,
  },
  {
    id: 'webhook_delivery',
    description: 'Webhooks (Paddle/Stripe/Inngest) processed within 30s',
    target: 0.995,
    window_days: 30,
    error_budget_minutes: 216,
    metric: 'webhook_p99_ms',
    threshold: 30000,
  },
  {
    id: 'inngest_function_success',
    description: 'Inngest scheduled functions complete without DLQ',
    target: 0.99,
    window_days: 30,
    error_budget_minutes: 432,
    metric: 'inngest_dlq_rate',
    threshold: 0.01,
  },
  {
    id: 'budget_enforcement',
    description: 'Per-business AI call budget never exceeded',
    target: 1.0, // hard SLO — any over-budget call is a breach
    window_days: 30,
    error_budget_minutes: 0,
    metric: 'budget_overrun_count',
    threshold: 0,
  },
  {
    id: 'oauth_token_decrypt_success',
    description: 'OAuth token decrypt never fails on a non-tampered blob',
    target: 0.9999, // hard — decrypt failure means lost customer data
    window_days: 30,
    error_budget_minutes: 4,
    metric: 'oauth_decrypt_error_rate',
    threshold: 0.0001,
  },
  {
    id: 'cost_per_business_growth',
    description: 'Growth-plan compute cost stays under $1.50/customer/day',
    target: 0.95,
    window_days: 30,
    error_budget_minutes: null, // billing SLO, no error budget
    metric: 'llm_cost_per_business_usd',
    threshold: 1.5,
  },
];

/**
 * Read a metric's current value from the registry. Counters and gauges
 * return the latest value; histograms return p99 from a synthetic
 * estimate over the bucket distribution.
 *
 * For real SLO math we'd want a time-series DB with a sliding 30-day
 * window — this snapshot is best-effort for fast-burn detection only.
 */
function readMetric(name) {
  const snap = metrics.snapshot();
  // Counters: sum all label-permutations for the metric name
  let counterSum = 0;
  let counterFound = false;
  for (const [k, v] of Object.entries(snap.counters)) {
    if (k.split('{')[0] === name) {
      counterSum += v;
      counterFound = true;
    }
  }
  if (counterFound) return counterSum;
  // Gauges: latest value (just take the first matching label set)
  for (const [k, v] of Object.entries(snap.gauges)) {
    if (k.split('{')[0] === name) return v;
  }
  // Histograms: estimate p99 from the cumulative bucket distribution.
  // metrics.observeHistogram stores cumulative counts (value <= bound),
  // so p99 is the smallest bucket where bucket_count >= ceil(total * 0.99).
  for (const [k, h] of Object.entries(snap.histograms)) {
    if (k.split('{')[0] !== name) continue;
    if (!h.count) return 0;
    const target = Math.ceil(h.count * 0.99);
    const sortedBounds = Object.keys(h.buckets)
      .map(Number)
      .sort((a, b) => a - b);
    for (const bound of sortedBounds) {
      if (h.buckets[bound] >= target) return bound;
    }
    return Infinity; // p99 above the last bucket
  }
  return null;
}

/**
 * Compute live attainment for each SLO. Returns the violating SLOs only.
 */
function getViolations() {
  const violations = [];
  for (const slo of SLOS) {
    const current = readMetric(slo.metric);
    if (current == null) continue; // metric not emitted yet — can't evaluate
    let breaching = false;
    if (slo.threshold === 0) {
      breaching = current > 0;
    } else {
      breaching = current > slo.threshold;
    }
    if (breaching) {
      violations.push({
        slo_id: slo.id,
        description: slo.description,
        target: slo.target,
        threshold: slo.threshold,
        current,
        breaching: true,
      });
    }
  }
  return violations;
}

/**
 * Fire a Sentry message tagged with `slo_violation` when any SLO is breaching.
 * Sentry alert rules should be configured to page on this tag.
 *
 * Call from a 60s interval in server.js (after Sentry init).
 */
function emitSentryAlerts() {
  if (!Sentry) return;
  const violations = getViolations();
  for (const v of violations) {
    Sentry.captureMessage(`SLO violation: ${v.slo_id}`, {
      level: 'warning',
      tags: {
        slo_violation: 'true',
        slo_id: v.slo_id,
      },
      extra: v,
    });
  }
  return violations.length;
}

function startSloMonitor({ intervalMs = 60_000 } = {}) {
  // Skip in tests / when Sentry is absent.
  if (!Sentry || process.env.NODE_ENV === 'test') return null;
  const handle = setInterval(emitSentryAlerts, intervalMs);
  handle.unref?.();
  return handle;
}

module.exports = {
  SLOS,
  getViolations,
  emitSentryAlerts,
  startSloMonitor,
};
