'use strict';

/**
 * routes/observability.js — first carve-out from server.js.
 *
 * This module follows the target pattern for every routes/*.js file:
 *
 *   1. Export a single `register({ app, ...deps })` function.
 *   2. Mount only HTTP handlers. No global state. No env reads outside deps.
 *   3. Every dep is explicit — sbGet, logger, etc. — never reach into
 *      server.js closures.
 *   4. Each route has a short JSDoc above it explaining intent +
 *      authorization expectations.
 *
 * Mount this from server.js with:
 *   require('./routes/observability').register({ app, observability, sbGet, apiError });
 *
 * The bigger goal is to drop server.js from ~11.8k lines to <4k by
 * pulling 30+ similar route groups out into routes/*.js files. This
 * is the template the rest of that work will follow.
 */

function register({ app, observability, sbGet, apiError, requireMetricsAuth }) {
  if (!app) throw new Error('routes/observability: app required');
  if (!observability) throw new Error('routes/observability: observability required');
  if (typeof requireMetricsAuth !== 'function') {
    throw new Error('routes/observability: requireMetricsAuth required');
  }

  // ─── /metrics ───────────────────────────────────────────────────────
  // Prometheus scrape — METRICS_SCRAPE_TOKEN or ORCHESTRATOR_SECRET required.
  app.get('/metrics', requireMetricsAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(observability.metrics.exportPrometheus());
  });

  // ─── /webhook/cost-report ───────────────────────────────────────────
  // Aggregated cost report across the last N days. Auth: requires
  // x-webhook-secret (mounted via the global /webhook auth middleware
  // in server.js).
  app.post('/webhook/cost-report', async (req, res) => {
    try {
      const days = Number(req.body?.days) || 7;
      const r = await observability.costTracker.buildCostReport({ sbGet, days });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'COST_REPORT_FAILED', e.message);
    }
  });
}

module.exports = { register };
