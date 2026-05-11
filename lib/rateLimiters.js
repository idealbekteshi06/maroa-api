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
      const bizKey = req.body?.businessId
        || req.body?.business_id
        || req.query?.businessId
        || req.query?.business_id
        || req.params?.businessId
        || req.params?.business_id;
      // Fall back to IPv6-safe IP key if no business id present.
      return `${name}:${bizKey || ipKeyGenerator(req.ip)}`;
    },
    message: { error: { code: 'RATE_LIMITED', message: `Too many ${name} requests for this business` } },
  });
}

const limits = {
  fastRead:       makeLimiter({ windowMs: 60_000, max: 60, name: 'fast_read' }),
  standardMutate: makeLimiter({ windowMs: 60_000, max: 30, name: 'standard_mutate' }),
  expensive:      makeLimiter({ windowMs: 60_000, max: 10, name: 'expensive_op' }),
  veryExpensive:  makeLimiter({ windowMs: 60_000, max: 5,  name: 'very_expensive_op' }),
  crontarget:     makeLimiter({ windowMs: 60_000, max: 2,  name: 'cron_target' }),
};

module.exports = { makeLimiter, limits };
