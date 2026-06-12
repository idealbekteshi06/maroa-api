'use strict';

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

let ratelimit = null;

// Hard ceiling on how long a rate-limit decision may take. The limiter is an
// availability guard, not a correctness gate — a slow/failing Upstash must
// never delay (or, worse, hang) the request it is protecting. 2026-06-11
// incident: rotated Upstash credentials left rl.limit() rejecting after ~6s
// of SDK retries; call sites that awaited it bare (async Express 4 handler,
// no catch) never sent a response, so every dashboard quick action hung and
// the frontend surfaced "Connection error" toasts.
const LIMIT_DECISION_TIMEOUT_MS = 1500;

// Throttle degraded-mode warnings so an Upstash outage logs once a minute,
// not once per request.
let _lastDegradedWarnAt = 0;

function getRateLimit() {
  if (!ratelimit && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, '1 m'),
    });
  }
  return ratelimit;
}

function _degraded(reason) {
  const now = Date.now();
  if (now - _lastDegradedWarnAt > 60_000) {
    _lastDegradedWarnAt = now;
    console.warn(
      `[rateLimit] Upstash unavailable (${reason}) — failing open. ` +
        'Check UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (rotated secrets?).'
    );
  }
  return { success: true, degraded: true, reason, limit: 20, remaining: 20, reset: Date.now() };
}

/**
 * Decide whether `identifier` is within its sliding-window budget.
 *
 * Contract (load-bearing — call sites await this bare inside Express 4 async
 * handlers): NEVER rejects and NEVER stalls past LIMIT_DECISION_TIMEOUT_MS.
 * On any Upstash failure or timeout it fails OPEN with {success:true,
 * degraded:true}. Callers that must not uncap expensive endpoints during an
 * outage (see aiRateLimit in server.js) check `degraded` and fall back to the
 * in-process limiter instead.
 *
 * @param {string} identifier bucket key (user id / business id / ip)
 * @param {{limit: Function}} [injectedLimiter] test seam — bypasses Upstash
 */
async function checkRateLimit(identifier, injectedLimiter) {
  const rl = injectedLimiter || getRateLimit();
  if (!rl) return { success: true, limit: 20, remaining: 20, reset: Date.now() };

  let timer;
  try {
    const decision = await Promise.race([
      rl.limit(String(identifier || 'anon')),
      new Promise((resolve) => {
        // NOTE: deliberately NOT unref()d. An unref'd timer doesn't keep the
        // event loop alive, so in loop-idle contexts (test runners, one-shot
        // scripts) the race could end with the loop draining before the
        // watchdog fires — Node 20's test runner failed exactly that way
        // ("Promise resolution is still pending but the event loop has
        // already resolved"). The finally{} below clears the timer on the
        // normal path, so a live ≤1.5s timer never lingers anyway.
        timer = setTimeout(() => resolve({ __timedOut: true }), LIMIT_DECISION_TIMEOUT_MS);
      }),
    ]);
    if (decision && decision.__timedOut) return _degraded('timeout');
    return decision;
  } catch (e) {
    return _degraded(e?.message || 'error');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkRateLimit, getRateLimit, LIMIT_DECISION_TIMEOUT_MS };
