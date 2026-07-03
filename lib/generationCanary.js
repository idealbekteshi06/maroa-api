'use strict';

/**
 * lib/generationCanary.js
 * ----------------------------------------------------------------------------
 * In-process heartbeat marker for the generation canary.
 *
 * WHY THIS EXISTS
 *   /readyz reports Anthropic "healthy" by pinging /v1/models — an endpoint
 *   that does NOT require credits. So generation can be fully down (exhausted
 *   credits, billing lapsed) while readiness stays green. This actually
 *   happened in prod for ~3 weeks.
 *
 *   The canary (services/inngest/functions.js → /webhook/generation-canary)
 *   makes ONE tiny real Claude call every ~30 min. On each run it records the
 *   result HERE, and /readyz reads it back as a `generation_canary` check.
 *
 * WHY IN-MEMORY (not a table / events row)
 *   `events.business_id` is NOT NULL and RLS-scoped per business — a global
 *   canary has no business, so writing there would either require a fake
 *   business_id or pollute per-customer event logs. An in-memory marker keeps
 *   /readyz cheap (no DB read on every probe) and needs no migration. The
 *   trade-off — the marker resets on redeploy and isn't shared across
 *   instances — is acceptable: a fresh instance simply reports "stale" until
 *   the next canary tick (≤30 min), which /readyz treats as a soft warning,
 *   never a hard failure.
 *
 * SOFT-FAIL CONTRACT
 *   Nothing here throws. A canary bug must never be able to break /readyz.
 * ----------------------------------------------------------------------------
 */

// Consider the heartbeat stale if the last successful run is older than this.
// Canary cadence is ~30 min, so 90 min tolerates two missed ticks before we
// warn — avoids flapping on a single skipped run or a slow redeploy.
const STALE_MS = 90 * 60 * 1000;

let _last = null; // { ok, at (ISO), reason, model, latency_ms }

function recordCanary(result = {}) {
  try {
    _last = {
      ok: !!result.ok,
      at: new Date().toISOString(),
      reason: result.reason != null ? String(result.reason).slice(0, 300) : null,
      model: result.model != null ? String(result.model).slice(0, 80) : null,
      latency_ms: Number.isFinite(result.latency_ms) ? result.latency_ms : null,
    };
  } catch {
    /* never throw from the canary recorder */
  }
  return _last;
}

/**
 * Read the current canary verdict for /readyz.
 *
 * Returns a check shaped like the other /readyz probes:
 *   { ok, skipped?, stale?, last_ok?, last_at?, age_ms?, reason? }
 *
 * `ok:true` means "generation is confirmed working" (last run succeeded and
 * is fresh). Any warning condition — never run yet, last run failed, or last
 * run is stale — returns `ok:false` so /readyz lists it as a soft_warning.
 * It is NEVER a hard failure (readiness must not 503 on a canary problem).
 */
function readCanary({ now = Date.now(), staleMs = STALE_MS } = {}) {
  if (!_last) {
    // Booted but the canary hasn't run yet (or reset on redeploy). Not an
    // alarm on its own — surfaces as skipped so a just-started instance
    // doesn't scream. The 30-min cron fills it in shortly.
    return { ok: true, skipped: true, reason: 'no_canary_yet' };
  }
  const lastAtMs = Date.parse(_last.at);
  const ageMs = Number.isFinite(lastAtMs) ? now - lastAtMs : null;
  const stale = ageMs == null || ageMs > staleMs;
  return {
    ok: !!_last.ok && !stale,
    stale,
    last_ok: _last.ok,
    last_at: _last.at,
    age_ms: ageMs,
    latency_ms: _last.latency_ms,
    model: _last.model,
    reason: !_last.ok ? _last.reason || 'canary_failed' : stale ? 'canary_stale' : null,
  };
}

// Test-only: clear the marker between unit tests.
function _reset() {
  _last = null;
}

module.exports = { recordCanary, readCanary, _reset, STALE_MS };
