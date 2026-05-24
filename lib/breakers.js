'use strict';

/**
 * lib/breakers.js
 * ----------------------------------------------------------------------------
 * Per-external-API circuit-breaker registry.
 *
 * Why a registry: each external API needs ONE breaker instance for the whole
 * process. Without this, every service that fires a fetch() would create
 * its own breaker — failures wouldn't accumulate to trip protection.
 *
 * Usage:
 *   const { breakers, fire } = require('./lib/breakers');
 *   await fire('higgsfield', () => httpsRequest(...));
 *   await fire('meta-marketing', () => fetch(...));
 *
 * On open circuit:
 *   - The call throws CircuitOpenError (instanceof Error, isCircuitOpen=true)
 *   - Caller decides: degrade gracefully, return null, surface to user
 *   - The breaker auto-tests recovery after openDurationMs
 *
 * Thresholds tuned per API based on observed failure profiles:
 *   - higgsfield: image/video generation, 30-60s normal latency, flaky.
 *                 Threshold 8 / window 120s — needs more room before opening.
 *   - paddle: payment API, must NEVER falsely open during a real customer
 *             purchase. Threshold 3 / openDuration 15s — fail fast, recover fast.
 *   - meta-marketing: Meta Graph v21, occasional regional outages.
 *                     Threshold 5 / openDuration 30s — standard pattern.
 *   - google-ads: Google Ads API. Threshold 5 / openDuration 30s.
 *   - anthropic: LLM. Threshold 5 / openDuration 20s — fail FAST so retries
 *                hit other Anthropic regions.
 *   - replicate: image gen fallback. Threshold 5 / openDuration 30s.
 *   - serpapi: SEO data. Threshold 4 / openDuration 60s — cheap to be patient.
 *
 * The onStateChange callback wires into observability so circuit trips
 * surface as Sentry events + Slack alerts (via lib/alertRouter).
 * ----------------------------------------------------------------------------
 */

const { CircuitBreaker, CircuitOpenError } = require('./circuitBreaker');

let _alertRouter = null;
let _logger = null;

/**
 * Optional one-time wiring at boot. If not called, breakers still work —
 * they just don't emit Sentry/Slack events on state change.
 */
function configureBreakers({ alertRouter, logger } = {}) {
  _alertRouter = alertRouter || null;
  _logger = logger || null;
}

function _onStateChange({ name, state, reason }) {
  // Best-effort emission — never throw from a state-change callback.
  try {
    _logger?.warn?.('/breakers', null, `circuit ${state}`, { breaker: name, reason });
  } catch {
    /* ignore */
  }
  try {
    if (_alertRouter && state === 'open') {
      _alertRouter
        .alert?.({
          severity: 'warning',
          title: `Circuit OPEN on ${name}`,
          message: `External API "${name}" failed beyond threshold. Reason: ${reason || 'unknown'}. Calls will fast-fail until recovery probe succeeds.`,
          key: `circuit-open:${name}`,
          extra: { breaker: name, source: 'lib/breakers' },
        })
        ?.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// Construct breakers lazily so an unused breaker doesn't add weight.
const _instances = new Map();

const BREAKER_CONFIG = Object.freeze({
  higgsfield: { threshold: 8, windowMs: 120_000, openDurationMs: 30_000 },
  paddle: { threshold: 3, windowMs: 60_000, openDurationMs: 15_000 },
  'meta-marketing': { threshold: 5, windowMs: 60_000, openDurationMs: 30_000 },
  'google-ads': { threshold: 5, windowMs: 60_000, openDurationMs: 30_000 },
  anthropic: { threshold: 5, windowMs: 60_000, openDurationMs: 20_000 },
  replicate: { threshold: 5, windowMs: 60_000, openDurationMs: 30_000 },
  serpapi: { threshold: 4, windowMs: 60_000, openDurationMs: 60_000 },
});

function getBreaker(name) {
  if (!_instances.has(name)) {
    const cfg = BREAKER_CONFIG[name] || { threshold: 5, windowMs: 60_000, openDurationMs: 30_000 };
    _instances.set(
      name,
      new CircuitBreaker({
        name,
        ...cfg,
        onStateChange: _onStateChange,
      })
    );
  }
  return _instances.get(name);
}

/**
 * Wrap any async function with the named breaker. Returns the function's
 * value on success. Throws CircuitOpenError when the circuit is open
 * (caller should treat that as "service unavailable, degrade gracefully").
 *
 * If the breaker name isn't registered in BREAKER_CONFIG, a default-config
 * breaker is created — so adding `fire('new-api', fn)` in a new service
 * just works without editing this file.
 */
async function fire(name, fn) {
  const breaker = getBreaker(name);
  return breaker.fire(fn);
}

/**
 * Surface the state of all instantiated breakers — used by /readyz, the
 * /status page, and Prometheus metrics.
 */
function snapshot() {
  const out = {};
  for (const [name, breaker] of _instances) {
    out[name] = {
      state: breaker.state,
      failureCount: breaker.failureCount,
      lastError: breaker.lastError ? String(breaker.lastError.message || breaker.lastError) : null,
    };
  }
  return out;
}

/**
 * Test-only: reset all breakers to closed state. Used in tests that need
 * isolated state. NOT for production use.
 */
function _resetAll() {
  for (const breaker of _instances.values()) {
    breaker.state = 'closed';
    breaker.failureTimestamps = [];
    breaker.lastError = null;
    breaker.openedAt = 0;
    breaker.halfOpenSuccesses = 0;
  }
}

module.exports = {
  configureBreakers,
  getBreaker,
  fire,
  snapshot,
  BREAKER_CONFIG,
  CircuitOpenError,
  _resetAll,
};
