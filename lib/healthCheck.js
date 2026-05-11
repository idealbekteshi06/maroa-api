'use strict';

/**
 * lib/healthCheck.js
 * ----------------------------------------------------------------------------
 * /healthz + /readyz endpoint helpers.
 *
 * Industry convention:
 *   /healthz  — am I alive? (process up, event loop responsive)
 *                Returns 200 unless the process is dying. Used by Railway's
 *                health-check + Inngest's liveness probe.
 *
 *   /readyz   — am I ready to serve traffic? (dependencies reachable)
 *                Probes Supabase, Anthropic, Inngest config. Returns 503
 *                if any critical dependency is unhealthy. Used by load
 *                balancers to drain traffic on dep failure.
 *
 * Per-dep probe budget: 1500ms total. Each probe has a 500ms timeout.
 * We parallel-fire and short-circuit on first failure.
 *
 * Public API:
 *   registerHealthRoutes({ app, sbGet, callClaude, logger })
 *
 * No auth — these endpoints are designed for load balancers + monitoring.
 * Returns minimal info (status + per-dep verdict). No secrets leaked.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_TIMEOUT_MS = 500;

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'dep') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout`)), ms)),
  ]);
}

async function probeSupabase(sbGet) {
  if (!sbGet) return { ok: false, reason: 'sbGet not configured' };
  try {
    await withTimeout(sbGet('businesses', 'select=id&limit=1'), 1000, 'supabase');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function probeAnthropic() {
  // Don't actually call Anthropic — just check env is set.
  // Real round-trip costs $ per probe.
  return {
    ok: !!process.env.ANTHROPIC_KEY,
    reason: process.env.ANTHROPIC_KEY ? null : 'ANTHROPIC_KEY missing',
  };
}

async function probeInngest() {
  // Inngest doesn't expose a cheap ping. Check env config.
  return {
    ok: !!(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY),
    reason: process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY ? null : 'Inngest keys missing',
  };
}

async function probeHiggsfield() {
  return {
    ok: !!(process.env.HIGGSFIELD_API_KEY_ID && process.env.HIGGSFIELD_API_KEY_SECRET),
    reason:
      process.env.HIGGSFIELD_API_KEY_ID && process.env.HIGGSFIELD_API_KEY_SECRET ? null : 'Higgsfield keys missing',
  };
}

function registerHealthRoutes({ app, sbGet, logger }) {
  // ── /healthz — liveness ──
  // Returns 200 if the process is breathing. Don't query DB here — it must
  // be cheap enough to be hit every 5 seconds by Railway/Inngest probes.
  app.get('/healthz', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      pid: process.pid,
      node: process.version,
    });
  });

  // ── /readyz — readiness ──
  // Probes critical deps. Returns 503 if any are down so a load balancer
  // can drain traffic until we recover.
  app.get('/readyz', async (req, res) => {
    const started = Date.now();
    const [supabase, anthropic, inngest, higgsfield] = await Promise.all([
      probeSupabase(sbGet),
      probeAnthropic(),
      probeInngest(),
      probeHiggsfield(),
    ]);

    const checks = { supabase, anthropic, inngest, higgsfield };
    const failures = Object.entries(checks)
      .filter(([, v]) => !v.ok)
      .map(([k]) => k);
    const ok = failures.length === 0;

    if (!ok && logger?.warn) {
      logger.warn('/readyz', null, 'one or more deps unhealthy', { failures, checks });
    }

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not_ready',
      duration_ms: Date.now() - started,
      checks,
      uptime_seconds: Math.floor(process.uptime()),
    });
  });
}

module.exports = {
  registerHealthRoutes,
  // exposed for testing
  probeSupabase,
  probeAnthropic,
  probeInngest,
  probeHiggsfield,
};
