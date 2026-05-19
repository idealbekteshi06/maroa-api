'use strict';

/**
 * lib/retryWithJitter.js
 * ----------------------------------------------------------------------------
 * Generic retry helper with exponential backoff + jitter.
 *
 * Why: Anthropic calls already retry inside callClaude(), but every other
 * external API (Meta Graph, Google Ads, Higgsfield, OpenAI embeddings,
 * SerpAPI) was a single-shot fetch. One transient 429 from Meta → workflow
 * lands in the Inngest DLQ. With retry+jitter, the same blip is absorbed.
 *
 * Composes with lib/breakers.js: callers typically wrap as
 *   await breakers.fire('meta-marketing', () =>
 *     retryWithJitter(() => fetch(...), { retries: 3 })
 *   );
 * The breaker opens after persistent failure across retries; the retries
 * absorb transient blips that shouldn't trip the breaker.
 *
 * Retryable by default: 408, 425, 429, 500, 502, 503, 504, plus network
 * errors (ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAI_AGAIN, AbortError).
 *
 * NOT retryable: 4xx other than the rate-limit set above; AbortController
 * cancellations triggered by the caller; CircuitOpenError (would defeat
 * the breaker's fast-fail).
 * ----------------------------------------------------------------------------
 */

const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const DEFAULT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function defaultIsRetryable(err) {
  if (!err) return false;
  if (err.isCircuitOpen) return false;
  if (err.name === 'AbortError' && err.causedByCaller) return false;
  if (err.status && typeof err.status === 'number') {
    return DEFAULT_RETRYABLE_STATUS.has(err.status);
  }
  if (err.statusCode && typeof err.statusCode === 'number') {
    return DEFAULT_RETRYABLE_STATUS.has(err.statusCode);
  }
  if (err.code && NETWORK_ERROR_CODES.has(err.code)) return true;
  if (err.name === 'FetchError' || err.name === 'TimeoutError') return true;
  if (typeof err.message === 'string' && /timeout|socket hang up|network/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Sleep with cancellation support. Resolves on timeout OR when signal aborts.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    }
  });
}

/**
 * Compute backoff delay for the given attempt (0-indexed).
 *
 * Formula: min(maxDelayMs, baseDelayMs * 2^attempt) + jitter
 * Jitter is full-random in [0, baseDelayMs] — "full jitter" per AWS
 * architecture guidance, avoids the thundering-herd of pure-deterministic
 * backoff (every retry fires at the same wall-clock moment).
 *
 * For 429 responses with Retry-After header, prefer that value (capped).
 */
function computeDelayMs({ attempt, baseDelayMs, maxDelayMs, retryAfterMs }) {
  if (retryAfterMs && Number.isFinite(retryAfterMs)) {
    return Math.min(maxDelayMs, Math.max(baseDelayMs, retryAfterMs));
  }
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = Math.random() * baseDelayMs;
  return Math.min(maxDelayMs, exp + jitter);
}

function parseRetryAfter(err) {
  const header =
    err?.headers?.['retry-after'] ||
    err?.response?.headers?.['retry-after'] ||
    err?.retryAfter ||
    null;
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return n * 1000;
  const ts = Date.parse(header);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

/**
 * retryWithJitter(fn, opts)
 *
 * @param {() => Promise<any>} fn  Async function to attempt. Called with no
 *     args; bind your own context via closure.
 * @param {object} opts
 * @param {number} [opts.retries=3]   Number of retry ATTEMPTS after the first.
 *     Total max calls = retries + 1. Set to 0 to disable retries (passthrough).
 * @param {number} [opts.baseDelayMs=200]  Initial backoff base.
 * @param {number} [opts.maxDelayMs=20000] Cap on any single backoff.
 * @param {(err) => boolean} [opts.isRetryable]  Override which errors retry.
 * @param {AbortSignal} [opts.signal]  Cancel the retry loop.
 * @param {(meta) => void} [opts.onRetry]  Called with {attempt, delayMs, err}
 *     before each backoff sleep — wire to metrics if you want.
 */
async function retryWithJitter(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 200,
    maxDelayMs = 20_000,
    isRetryable = defaultIsRetryable,
    signal,
    onRetry,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) {
      const e = new Error('retry_aborted');
      e.name = 'AbortError';
      e.causedByCaller = true;
      throw e;
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === retries;
      if (isLast || !isRetryable(err)) throw err;
      const delayMs = computeDelayMs({
        attempt,
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: parseRetryAfter(err),
      });
      if (typeof onRetry === 'function') {
        try {
          onRetry({ attempt: attempt + 1, delayMs, err });
        } catch {
          /* observer must not break the loop */
        }
      }
      await sleep(delayMs, signal);
    }
  }
  throw lastErr;
}

module.exports = {
  retryWithJitter,
  defaultIsRetryable,
  computeDelayMs,
  NETWORK_ERROR_CODES,
  DEFAULT_RETRYABLE_STATUS,
};
