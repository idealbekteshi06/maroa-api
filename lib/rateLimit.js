'use strict';

const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

let ratelimit = null;

function getRateLimit() {
  if (!ratelimit && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, '1 m')
    });
  }
  return ratelimit;
}

async function checkRateLimit(identifier) {
  const rl = getRateLimit();
  if (!rl) return { success: true, limit: 20, remaining: 20, reset: Date.now() };
  return rl.limit(String(identifier || 'anon'));
}

module.exports = { checkRateLimit, getRateLimit };
