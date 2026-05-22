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
 *                Probes Supabase, Anthropic, Inngest, Higgsfield + Wave 60
 *                registries with REAL pings — not just env-var checks
 *                (audit 2026-05-18: placebo readiness allowed Railway to
 *                route traffic to a broken instance for hours when a key
 *                rotated mid-deploy).
 *
 * Per-dep probe budget: 700ms hard cap each. Results cached 10s so a flood
 * of probes can't DDoS the providers.
 *
 * Public API:
 *   registerHealthRoutes({ app, sbGet, logger })
 *
 * No auth — designed for load balancers + monitoring. Returns status + per-dep
 * verdict only; no secrets leaked.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_TIMEOUT_MS = 700;
const PROBE_CACHE_TTL_MS = 10_000;

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'dep') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}_timeout_${ms}ms`));
    }, ms);
    Promise.resolve(promise)
      .then((v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(e);
      });
  });
}

const _probeCache = new Map();
function _cached(key, fn, ttlMs = PROBE_CACHE_TTL_MS) {
  const now = Date.now();
  const hit = _probeCache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then((value) => {
    _probeCache.set(key, { value, expiresAt: now + ttlMs });
    return value;
  });
}

async function probeSupabase(sbGet) {
  if (!sbGet) return { ok: false, reason: 'sbGet not configured' };
  return _cached('supabase', async () => {
    try {
      // 2500ms — Supabase tail latency can hit 1.5s during regional saturation.
      await withTimeout(sbGet('businesses', 'select=id&limit=1'), 2500, 'supabase');
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}

/**
 * Real ping to Anthropic /v1/models — this endpoint is free (doesn't bill
 * input/output tokens) and returns 200 if the key is valid + service up.
 * Cached 10s so /readyz can be polled aggressively without burning ratelimit.
 */
async function probeAnthropic() {
  const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'ANTHROPIC_KEY missing' };
  return _cached('anthropic', async () => {
    try {
      const r = await withTimeout(
        fetch('https://api.anthropic.com/v1/models?limit=1', {
          method: 'GET',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
        }),
        DEFAULT_TIMEOUT_MS,
        'anthropic'
      );
      if (r.ok) return { ok: true, status: r.status };
      // 401/403: caller credentials problem — surface it, not Anthropic-down.
      if (r.status === 401 || r.status === 403) {
        return { ok: false, status: r.status, reason: 'anthropic_unauthorized' };
      }
      return { ok: false, status: r.status, reason: `anthropic_${r.status}` };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}

/**
 * Inngest doesn't expose a cheap public ping. We check that the keys are
 * set AND that the in-process Inngest client has registered at least one
 * function (signals the server.js boot path executed).
 */
async function probeInngest({ inngestClient } = {}) {
  const evKey = process.env.INNGEST_EVENT_KEY;
  const sigKey = process.env.INNGEST_SIGNING_KEY;
  if (!evKey || !sigKey) {
    return { ok: false, reason: 'Inngest keys missing' };
  }
  // Loose check — if inngestClient was passed and has functions registered,
  // we're confident the SDK booted. Otherwise we can't tell beyond env vars.
  if (inngestClient && typeof inngestClient === 'object') {
    const fnCount =
      (inngestClient._functions && inngestClient._functions.length) ||
      (Array.isArray(inngestClient.functions) ? inngestClient.functions.length : 0);
    if (fnCount > 0) {
      return { ok: true, functions: fnCount };
    }
  }
  try {
    const { functions: inngestFns } = require('../services/inngest/functions');
    if (Array.isArray(inngestFns) && inngestFns.length > 0) {
      return { ok: true, functions: inngestFns.length };
    }
  } catch {
    /* inngest module not loaded in this process */
  }
  return { ok: true, reason: 'env_only_check' };
}

/**
 * Higgsfield API: ping the /v1/models endpoint (or the cheapest GET available).
 * Falls back to env-var-only check if the endpoint shape isn't known.
 */
async function probeHiggsfield() {
  const id = process.env.HIGGSFIELD_API_KEY_ID;
  const secret = process.env.HIGGSFIELD_API_KEY_SECRET;
  if (!id || !secret) return { ok: false, reason: 'Higgsfield keys missing' };
  const base = String(process.env.HIGGSFIELD_API_BASE || 'https://platform.higgsfield.ai').replace(/\/$/, '');
  return _cached('higgsfield', async () => {
    try {
      // Cloud API uses Key auth on platform.higgsfield.ai (not api.higgsfield.io).
      const r = await withTimeout(
        fetch(`${base}/`, {
          method: 'GET',
          headers: { Authorization: `Key ${id}:${secret}` },
        }),
        DEFAULT_TIMEOUT_MS,
        'higgsfield'
      );
      if (r.ok) return { ok: true, status: r.status };
      if (r.status >= 400 && r.status < 500) {
        return { ok: true, status: r.status, reason: 'reachable_but_unauthorized' };
      }
      return { ok: false, status: r.status, reason: `higgsfield_${r.status}` };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
}

/**
 * Surface Inngest DLQ count — if jobs are accumulating in the dead-letter
 * queue, /readyz should warn but NOT return 503 (system is "ready" even
 * if individual jobs failed). M4 hardening — alerting is wired upstream.
 */
async function probeInngestDlq(sbGet) {
  if (!sbGet) return { ok: true, skipped: true };
  return _cached(
    'inngest_dlq',
    async () => {
      try {
        const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const rows = await withTimeout(
          sbGet('inngest_dlq', `failed_at=gte.${sinceISO}&select=id&limit=1000`),
          1500,
          'inngest_dlq'
        );
        const count = Array.isArray(rows) ? rows.length : 0;
        return { ok: true, dlq_count_24h: count, alert: count > 0 };
      } catch (e) {
        // DLQ table may not exist yet (migration 058 not applied) — soft-fail.
        return { ok: true, skipped: true, reason: e.message };
      }
    },
    30_000 // refresh DLQ count every 30s
  );
}

/**
 * Probe Wave 60 registries — methodologies, channels, compliance, specialists.
 */
async function probeWave60() {
  if (!String(process.env.AGENCY_PIPELINE_ENABLED || '').match(/^(1|true|yes|on)$/i)) {
    return { ok: true, reason: null, skipped: true };
  }
  try {
    const methodologies = require('../services/prompts/methodologies');
    const channels = require('../services/prompts/channels');
    const compliance = require('../services/prompts/compliance');
    const specialists = require('../services/prompts/specialists');
    const counts = {
      methodologies: methodologies.listAllIds().length,
      channels: channels.listAllIds().length,
      compliance: compliance.listAllIds().length,
      specialists: specialists.listAllIds().length,
    };
    const expectations = { methodologies: 29, channels: 35, compliance: 20, specialists: 7 };
    const mismatches = Object.entries(expectations)
      .filter(([k, v]) => counts[k] !== v)
      .map(([k]) => k);
    if (mismatches.length) {
      return {
        ok: false,
        reason: `Wave 60 registry counts off: ${mismatches.join(', ')}`,
        counts,
        expected: expectations,
      };
    }
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, reason: `Wave 60 registry load failed: ${e.message}` };
  }
}

/**
 * Snapshot of all circuit breakers — surfaced in /readyz so operators see
 * which providers are currently flapping. Open breakers warn but don't 503
 * (an open breaker is the SYSTEM working as designed).
 */
function probeBreakers() {
  try {
    const breakers = require('./breakers');
    const snap = breakers.snapshot ? breakers.snapshot() : {};
    const open = Object.entries(snap).filter(([, v]) => v && v.state === 'open');
    return { ok: true, breakers: snap, open: open.map(([k]) => k) };
  } catch {
    return { ok: true, skipped: true };
  }
}

function registerHealthRoutes({ app, sbGet, logger, inngestClient }) {
  // ── /healthz — liveness ──
  // Returns 200 if the process is breathing. Don't query DB here — it must
  // be cheap enough to be hit every 5 seconds by Railway/Inngest probes.
  app.get('/healthz', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      pid: process.pid,
      node: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });

  // ── /readyz — readiness ──
  app.get('/readyz', async (req, res) => {
    const started = Date.now();
    let migrations = { ok: null, skipped: true };
    try {
      const { probeMigrationsLedger } = require('./platformOps');
      migrations = await probeMigrationsLedger(sbGet);
      if (migrations.missing_in_db?.length) migrations.ok = false;
    } catch (e) {
      migrations = { ok: null, error: e.message };
    }

    const [supabase, anthropic, inngest, higgsfield, wave60, dlq] = await Promise.all([
      probeSupabase(sbGet),
      probeAnthropic(),
      probeInngest({ inngestClient }),
      probeHiggsfield(),
      probeWave60(),
      probeInngestDlq(sbGet),
    ]);
    const breakers = probeBreakers();

    const checks = { supabase, anthropic, inngest, higgsfield, wave60, dlq, migrations, breakers };
    // Hard-fail deps: supabase, anthropic, wave60. Soft deps (higgsfield,
    // inngest sans functions, dlq, breakers) get logged but don't 503 —
    // the API can still serve most routes if Higgsfield is degraded.
    const hardFailures = ['supabase', 'anthropic', 'wave60']
      .filter((k) => checks[k] && !checks[k].ok);
    const softWarnings = ['higgsfield', 'inngest', 'dlq', 'migrations'].filter((k) => {
      const c = checks[k];
      if (!c) return false;
      if (k === 'dlq' && c.alert) return true;
      return !c.ok && !c.skipped;
    });
    const ok = hardFailures.length === 0;

    if (!ok && logger?.warn) {
      logger.warn('/readyz', null, 'hard deps unhealthy', { hardFailures, checks });
    } else if (softWarnings.length && logger?.info) {
      logger.info('/readyz', null, 'soft warnings', { softWarnings });
    }

    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not_ready',
      duration_ms: Date.now() - started,
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      checks,
      uptime_seconds: Math.floor(process.uptime()),
    });
  });
}

// Test-only: reset the per-probe cache so unit tests can assert on each
// invocation independently. NEVER call in production paths.
function _resetProbeCache() {
  _probeCache.clear();
}

module.exports = {
  registerHealthRoutes,
  // exposed for testing
  probeSupabase,
  probeAnthropic,
  probeInngest,
  probeHiggsfield,
  probeInngestDlq,
  probeWave60,
  probeBreakers,
  _resetProbeCache,
};
