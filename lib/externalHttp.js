'use strict';

/**
 * lib/externalHttp.js
 * ----------------------------------------------------------------------------
 * Single hardened wrapper around external HTTP calls.
 *
 * What it does (auto, per-URL):
 *   1. Picks the right per-service timeout (lib/serviceTimeouts).
 *   2. Routes the call through the matching circuit breaker
 *      (lib/breakers) so one downed provider can't take the whole worker pool.
 *   3. Adds exponential backoff + jitter on retryable failures
 *      (lib/retryWithJitter) so transient 429/5xx blips don't surface to
 *      customers.
 *
 * Why a new helper instead of monkey-patching apiRequest():
 *   - apiRequest() is also used for Supabase/internal calls that don't
 *     want breaker semantics. Forcing the breaker onto it would falsely
 *     trip from internal load spikes.
 *   - This is opt-in for external call sites. Migration is a one-line
 *     `apiRequest(` → `externalHttp(` swap.
 *
 * Usage:
 *   const externalHttp = require('./lib/externalHttp');
 *   const r = await externalHttp(apiRequest, 'GET', url, headers);
 *
 * Or, more commonly, with a pre-bound apiRequest:
 *   const ext = externalHttp.bind(apiRequest);
 *   const r = await ext('GET', url, headers);
 * ----------------------------------------------------------------------------
 */

const { fire: fireBreaker } = require('./breakers');
const { retryWithJitter } = require('./retryWithJitter');
const { timeoutForUrl, breakerForUrl } = require('./serviceTimeouts');

const DEFAULT_RETRIES = 2; // 1 initial + 2 retries = 3 max
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 10_000;

function _isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Make an external HTTP call with breaker + retry + per-service timeout.
 *
 * @param {Function} apiRequest  The lowest-level HTTP helper (POST/GET → {status, body}).
 * @param {string}   method      HTTP method.
 * @param {string}   url         Absolute URL.
 * @param {object}   [headers]   Request headers.
 * @param {*}        [body]      Request body (JSON-serializable).
 * @param {object}   [opts]      { retries, baseDelayMs, maxDelayMs, breakerName, timeoutMs, onRetry }
 * @returns {Promise<{status, body, fromBreakerName}>}
 */
async function externalHttp(apiRequest, method, url, headers = {}, body = null, opts = {}) {
  if (typeof apiRequest !== 'function') {
    throw new TypeError('externalHttp: apiRequest must be a function (first arg)');
  }
  const timeoutMs = opts.timeoutMs || timeoutForUrl(url);
  const breakerName = opts.breakerName || breakerForUrl(url);
  const retries = opts.retries !== undefined ? opts.retries : DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs || BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs || MAX_DELAY_MS;

  const exec = async () => {
    const resp = await apiRequest(method, url, headers, body, timeoutMs);
    // Treat retryable HTTP status the same as a thrown error so the breaker
    // counts persistent 5xx as real failures.
    if (resp && _isRetryableStatus(resp.status)) {
      const err = new Error(
        `external_http_${resp.status}: ${method} ${url} → ${JSON.stringify(resp.body).slice(0, 200)}`
      );
      err.status = resp.status;
      err._response = resp;
      // Expose headers so retryWithJitter.parseRetryAfter can honor Retry-After.
      err.headers = resp.headers || {};
      throw err;
    }
    return resp;
  };

  const wrapped = breakerName ? () => fireBreaker(breakerName, exec) : exec;

  let result;
  try {
    result = await retryWithJitter(wrapped, {
      retries,
      baseDelayMs,
      maxDelayMs,
      onRetry: opts.onRetry,
    });
  } catch (e) {
    // Caller-side 4xx that escaped through the retry (because isRetryable
    // returns false for them) — surface the response unchanged.
    if (e && e._response) return { ...e._response, fromBreakerName: breakerName || null };
    // CircuitOpenError or terminal failure — re-throw for caller.
    throw e;
  }
  return { ...result, fromBreakerName: breakerName || null };
}

module.exports = externalHttp;
module.exports.externalHttp = externalHttp;
