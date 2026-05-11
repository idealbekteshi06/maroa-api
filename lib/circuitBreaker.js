'use strict';

/**
 * lib/circuitBreaker.js
 * ----------------------------------------------------------------------------
 * Circuit-breaker pattern around external APIs.
 *
 * Why: if Meta Marketing API is down, we DON'T want every customer's daily
 * ad audit to wait 30 seconds for a timeout, then retry, then wait again.
 * Cascading failures eat Anthropic budget on the LLM analysis steps that
 * fire after the empty Meta response, eat Inngest credits on retries, and
 * eat operator attention on alert spam.
 *
 * Three states:
 *   CLOSED      — calls flow through normally. Failures accumulate.
 *   OPEN        — fast-fail. Reject calls immediately with CircuitOpenError.
 *                 Saves ~30s × every request. Cooldown timer counts down.
 *   HALF_OPEN   — cooldown elapsed. Let ONE call through to test recovery.
 *                 Success → CLOSED. Failure → OPEN again.
 *
 * Defaults tuned for Maroa's external API patterns:
 *   - threshold: 5 failures in 60s → open
 *   - openDurationMs: 30s before HALF_OPEN
 *   - successesToClose: 1 (single success in HALF_OPEN re-closes)
 *
 * Public API:
 *   const breaker = new CircuitBreaker({ name: 'meta-api' })
 *   await breaker.fire(() => fetch(...))
 *
 *   breaker.state          — 'closed' | 'open' | 'half_open'
 *   breaker.failureCount   — current rolling failure count
 *   breaker.lastError      — last underlying error
 *
 * Per-API breaker instance — register once in server.js, use everywhere.
 * ----------------------------------------------------------------------------
 */

class CircuitOpenError extends Error {
  constructor(breakerName, cooldownMs) {
    super(`circuit_open:${breakerName}:retry_in_${cooldownMs}ms`);
    this.name = 'CircuitOpenError';
    this.breakerName = breakerName;
    this.cooldownMs = cooldownMs;
    this.isCircuitOpen = true;
  }
}

class CircuitBreaker {
  constructor({
    name = 'breaker',
    threshold = 5,
    windowMs = 60 * 1000,
    openDurationMs = 30 * 1000,
    successesToClose = 1,
    onStateChange = null,
  } = {}) {
    this.name = name;
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.openDurationMs = openDurationMs;
    this.successesToClose = successesToClose;
    this.onStateChange = onStateChange;

    this.state = 'closed';
    this.failureTimestamps = [];
    this.lastError = null;
    this.openedAt = 0;
    this.halfOpenSuccesses = 0;
  }

  _now() { return Date.now(); }

  _prune() {
    const cutoff = this._now() - this.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }

  get failureCount() {
    this._prune();
    return this.failureTimestamps.length;
  }

  _trip(reason) {
    if (this.state === 'open') return;
    this.state = 'open';
    this.openedAt = this._now();
    this.halfOpenSuccesses = 0;
    this.onStateChange?.({ name: this.name, state: 'open', reason });
  }

  _attemptHalfOpen() {
    const elapsed = this._now() - this.openedAt;
    if (this.state === 'open' && elapsed >= this.openDurationMs) {
      this.state = 'half_open';
      this.halfOpenSuccesses = 0;
      this.onStateChange?.({ name: this.name, state: 'half_open' });
    }
  }

  _recordSuccess() {
    if (this.state === 'half_open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.successesToClose) {
        this.state = 'closed';
        this.failureTimestamps = [];
        this.onStateChange?.({ name: this.name, state: 'closed' });
      }
    } else if (this.state === 'closed') {
      // Optional: decay failure count on successes (we keep it simple — prune by time only)
    }
  }

  _recordFailure(err) {
    this.lastError = err;
    if (this.state === 'half_open') {
      this._trip('half_open_failure');
      return;
    }
    this.failureTimestamps.push(this._now());
    this._prune();
    if (this.failureTimestamps.length >= this.threshold) {
      this._trip(`threshold_${this.threshold}_in_${this.windowMs}ms`);
    }
  }

  /**
   * Execute fn() through the breaker. Throws CircuitOpenError if open.
   * On half_open, allows ONE call through (others fast-fail).
   */
  async fire(fn) {
    this._attemptHalfOpen();
    if (this.state === 'open') {
      const cooldown = this.openDurationMs - (this._now() - this.openedAt);
      throw new CircuitOpenError(this.name, Math.max(0, cooldown));
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure(err);
      throw err;
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failure_count: this.failureCount,
      threshold: this.threshold,
      window_ms: this.windowMs,
      open_duration_ms: this.openDurationMs,
      last_error: this.lastError?.message || null,
      opened_at: this.openedAt || null,
    };
  }
}

// ─── Registry of per-API breakers ─────────────────────────────────────────

const _breakers = new Map();

function getBreaker(name, opts = {}) {
  if (!_breakers.has(name)) {
    _breakers.set(name, new CircuitBreaker({ name, ...opts }));
  }
  return _breakers.get(name);
}

function allBreakers() {
  return Array.from(_breakers.values()).map((b) => b.snapshot());
}

module.exports = { CircuitBreaker, CircuitOpenError, getBreaker, allBreakers };
