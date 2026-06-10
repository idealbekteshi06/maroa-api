'use strict';

/**
 * lib/rateLimiters.js
 * ----------------------------------------------------------------------------
 * Shared per-business rate-limit factory. Used by every route module so we
 * have ONE pattern, ONE place to tune defaults.
 *
 * Per-business keying (not per-IP) because internal cron crons hit these
 * routes from localhost — IP keys would let one runaway customer impact all.
 * Per-business keys bound the blast radius to one customer.
 *
 * Public API:
 *   makeLimiter({ windowMs, max, name, keySource = 'businessId' })
 *     → express middleware
 *   limits  — a dict of pre-configured limiters for common patterns
 *     - .fastRead       60s/60   — list/get endpoints
 *     - .standardMutate 60s/30   — create/update endpoints
 *     - .expensive      60s/10   — paid LLM calls
 *     - .veryExpensive  60s/5    — Anthropic Opus / large batches
 *     - .crontarget     60s/2    — webhook fanouts (should only fire ~once/cron)
 * ----------------------------------------------------------------------------
 */

const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

function makeLimiter({ windowMs = 60 * 1000, max = 60, name = 'route', keySource = 'businessId' } = {}) {
  return expressRateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Prefer the JWT-verified principal (req.user.id) — unspoofable. A
      // body/query/params business_id is attacker-controlled, so keying on it
      // let a client rotate ids to get a fresh bucket per request and never hit
      // the limit. Only trust a route param when it's been ownership-verified
      // (req.verifiedBusinessId, set by assertBusinessOwner). Else fall back to
      // the IPv6-safe client IP.
      const key = req.user?.id || req.verifiedBusinessId || ipKeyGenerator(req.ip);
      return `${name}:${key}`;
    },
    message: { error: { code: 'RATE_LIMITED', message: `Too many ${name} requests for this business` } },
  });
}

const limits = {
  fastRead: makeLimiter({ windowMs: 60_000, max: 60, name: 'fast_read' }),
  standardMutate: makeLimiter({ windowMs: 60_000, max: 30, name: 'standard_mutate' }),
  expensive: makeLimiter({ windowMs: 60_000, max: 10, name: 'expensive_op' }),
  veryExpensive: makeLimiter({ windowMs: 60_000, max: 5, name: 'very_expensive_op' }),
  crontarget: makeLimiter({ windowMs: 60_000, max: 2, name: 'cron_target' }),
};

module.exports = { makeLimiter, limits };
