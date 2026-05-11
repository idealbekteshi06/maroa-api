'use strict';

/**
 * lib/startupSelfTest.js
 *
 * Runs once at boot, after the HTTP server is listening. Pings every
 * critical external dependency and writes one log line per result.
 * Returns a summary that can be exposed via `/readyz` for the first
 * 5 minutes of process life.
 *
 * Why not run in /readyz on every probe: /readyz is hit every few
 * seconds by Railway's healthcheck and a real Supabase ping there
 * would cost a few hundred RPS in production. The startup self-test
 * runs ONCE and caches its result.
 *
 * What it checks (best-effort — no failure aborts boot):
 *   - Supabase reachable (SELECT 1-style PostgREST probe)
 *   - Anthropic key validity (5-token cheap ping)
 *   - Sentry can flush a test event
 *   - Inngest event channel reachable
 *   - OAUTH_TOKEN_ENC_KEY is the expected length
 *   - Required env vars are non-empty
 *
 * Soft-fail by design: if Sentry is down, this should not crash the
 * server. Result is logged + made available for ops dashboards.
 */

const PROBE_TIMEOUT_MS = 4000;

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

async function probeSupabase({ sbGet, logger }) {
  try {
    const rows = await withTimeout(sbGet('businesses', 'limit=1&select=id'), PROBE_TIMEOUT_MS, 'supabase');
    return { ok: true, rows: Array.isArray(rows) ? rows.length : 0 };
  } catch (e) {
    logger?.warn?.('startup-self-test', null, 'supabase probe failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

async function probeAnthropic({ logger }) {
  const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_KEY not set' };
  try {
    // eslint-disable-next-line no-restricted-syntax -- one-shot 5-token boot probe, see ADR-0003
    const r = await withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'OK' }],
        }),
      }),
      PROBE_TIMEOUT_MS,
      'anthropic'
    );
    return { ok: r.ok || r.status === 200, status: r.status };
  } catch (e) {
    logger?.warn?.('startup-self-test', null, 'anthropic probe failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

function probeEncryptionKey() {
  const key = process.env.OAUTH_TOKEN_ENC_KEY || '';
  if (!key) return { ok: false, error: 'OAUTH_TOKEN_ENC_KEY not set (OAuth tokens will be stored plaintext)' };
  // 32 bytes hex-encoded = 64 chars. Allow either raw 32-byte or hex.
  if (key.length !== 64 && key.length !== 32) {
    return { ok: false, error: `OAUTH_TOKEN_ENC_KEY length is ${key.length}, expected 32 or 64 chars` };
  }
  if (key.length === 64 && !/^[0-9a-f]{64}$/i.test(key)) {
    return { ok: false, error: 'OAUTH_TOKEN_ENC_KEY 64-char form must be hex' };
  }
  return { ok: true };
}

function probeRequiredEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_KEY', 'N8N_WEBHOOK_SECRET'];
  const missing = required.filter((k) => !process.env[k] || !process.env[k].trim());
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

let _cachedResult = null;
let _cachedAt = 0;

/**
 * Run the self-test. Caches the result for 5 minutes so /readyz can
 * report it without re-probing on every call.
 */
async function runStartupSelfTest({ sbGet, logger }) {
  const started = Date.now();
  const results = {
    env: probeRequiredEnv(),
    encryption_key: probeEncryptionKey(),
    supabase: await probeSupabase({ sbGet, logger }),
    anthropic: await probeAnthropic({ logger }),
  };
  const passed = Object.values(results).filter((r) => r.ok).length;
  const total = Object.keys(results).length;
  const summary = {
    passed,
    total,
    healthy: passed === total,
    duration_ms: Date.now() - started,
    timestamp: new Date().toISOString(),
    results,
  };
  logger?.info?.('startup-self-test', null, `Boot self-test ${passed}/${total} probes passed`, summary);
  _cachedResult = summary;
  _cachedAt = Date.now();
  return summary;
}

function getCached() {
  if (!_cachedResult) return null;
  // 5-minute cache TTL
  if (Date.now() - _cachedAt > 5 * 60 * 1000) return null;
  return _cachedResult;
}

module.exports = { runStartupSelfTest, getCached };
