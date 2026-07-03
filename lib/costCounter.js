'use strict';

/**
 * lib/costCounter.js — Atomic per-business monthly LLM $-spend counter.
 *
 * WHY: lib/costGuard.js gated on the monthly cap by paginating ALL of a
 * business's llm_cost_logs rows on EVERY gated request, then comparing the
 * sum to the cap. Two problems the 2026-07-03 audit flagged:
 *   1. Race: the sum is read, allow/deny decided, and the actual cost row is
 *      written downstream AFTER the Claude call. N concurrent requests all
 *      read the same pre-call sum and all pass → the cap is exceeded by up to
 *      (N-1)×cost.
 *   2. Latency bomb: paginating up to 200k rows on every gated call.
 *
 * FIX: keep an authoritative running total in Upstash Redis, keyed per
 * (business, calendar-month UTC):
 *   - The gate reads the counter — O(1), atomic — instead of scanning rows.
 *   - The cost tracker adds each call's actual cost to the counter right after
 *     it logs the row (single source of truth stays llm_cost_logs; Redis is a
 *     fast, live mirror).
 *   - On the first read of a month for a business, the counter is SEEDED from
 *     the DB sum (once) so historical month-to-date spend is included; a
 *     `SET … NX` makes concurrent seeders converge on one value.
 *
 * Residual race is now bounded to in-flight concurrency × per-call cost (a few
 * cents) rather than unbounded — and we DON'T pre-reserve an estimate, which
 * avoids the far worse failure mode of a reservation leaking (and permanently
 * inflating the counter) when a handler errors before its Claude call.
 *
 * No Redis configured → every function returns mode:'no_redis' and the caller
 * (costGuard) transparently falls back to the legacy DB-pagination path.
 *
 * Key:   maroa:cost:<businessId>:<YYYYMM>   (float USD, TTL ~40 days)
 */

let _redis = null;
let _redisInitTried = false;

function getRedis() {
  if (_redisInitTried) return _redis;
  _redisInitTried = true;
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) return null;
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    return _redis;
  } catch (e) {
    console.warn('[costCounter] Upstash init failed — falling back to legacy DB sum', e.message);
    return null;
  }
}

function monthKey(businessId) {
  const d = new Date();
  const yyyymm = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `maroa:cost:${businessId}:${yyyymm}`;
}

// ~40 days: comfortably past any month length so a key never expires mid-month,
// and auto-cleans a month or so after the month ends.
const TTL_SECONDS = 40 * 24 * 60 * 60;

/**
 * Return the authoritative month-to-date spend for a business.
 * Seeds the Redis counter from `seedFromDb()` on first read of the month.
 *
 * @param {object} p
 * @param {string} p.businessId
 * @param {() => Promise<number>} p.seedFromDb  computes the DB month-to-date sum
 * @returns {Promise<{usedUsd:number, mode:'atomic'|'seeded'|'no_redis'|'redis_error'}>}
 */
async function getMonthlyCostUsd({ businessId, seedFromDb }) {
  if (!businessId) return { usedUsd: 0, mode: 'no_redis' };
  const redis = getRedis();
  if (!redis) return { usedUsd: 0, mode: 'no_redis' };

  const key = monthKey(businessId);
  try {
    const existing = await redis.get(key);
    if (existing !== null && existing !== undefined) {
      return { usedUsd: Number(existing) || 0, mode: 'atomic' };
    }
    // First read this month — seed from the DB sum, then let Redis own it.
    const seed = typeof seedFromDb === 'function' ? Number(await seedFromDb()) || 0 : 0;
    // NX so two concurrent seeders don't clobber each other; if we lost the
    // race, read back the winner's value.
    const setOk = await redis.set(key, seed, { nx: true, ex: TTL_SECONDS });
    if (setOk === null) {
      const now = await redis.get(key);
      return { usedUsd: Number(now) || seed, mode: 'atomic' };
    }
    return { usedUsd: seed, mode: 'seeded' };
  } catch (e) {
    return { usedUsd: 0, mode: 'redis_error', error: e.message };
  }
}

/**
 * Add a call's actual cost to the live counter (called by the cost tracker
 * right after the row is written). Only mutates a counter that already exists
 * for the month — if it hasn't been seeded yet, we skip, because the cost is
 * already in llm_cost_logs and the next gate read will seed a sum that
 * includes it. This prevents an un-seeded counter from starting mid-month at
 * just this one call's cost (which would grossly UNDER-count and let a
 * near-cap business blow past it).
 *
 * Best-effort: never throws.
 */
async function addMonthlyCostUsd({ businessId, costUsd }) {
  if (!businessId || !Number.isFinite(Number(costUsd)) || Number(costUsd) <= 0) return { mode: 'noop' };
  const redis = getRedis();
  if (!redis) return { mode: 'no_redis' };
  const key = monthKey(businessId);
  try {
    const exists = await redis.exists(key);
    if (!exists) return { mode: 'not_seeded_skip' };
    const newVal = await redis.incrbyfloat(key, Number(costUsd));
    // Refresh TTL so an active business's counter never expires mid-month.
    await redis.expire(key, TTL_SECONDS).catch(() => {});
    return { usedUsd: Number(newVal) || 0, mode: 'atomic' };
  } catch (e) {
    return { mode: 'redis_error', error: e.message };
  }
}

// Test seam: inject a fake Redis client (must implement get/set/exists/
// incrbyfloat/expire) to exercise the atomic paths without a live Upstash.
function __setRedisForTest(client) {
  _redis = client;
  _redisInitTried = true;
}

module.exports = { getMonthlyCostUsd, addMonthlyCostUsd, monthKey, __setRedisForTest };
