'use strict';

/**
 * lib/budgetCounter.js — Atomic per-business daily AI-call budget.
 *
 * Fixes the race condition flagged in ADR-0004 item #7 (Antigravity
 * review 2026-05-11): the prior implementation read from
 * `orchestration_logs`, decided allow/deny, then wrote the log async
 * AFTER the Claude call succeeded. Under concurrency N parallel
 * requests all see the same pre-call count and all proceed past the
 * limit.
 *
 * Fix: atomic INCR via Upstash Redis. Each business+day has a counter
 * key. On every Claude call we:
 *   1. INCR the counter (atomic, returns new value)
 *   2. If new value > budget, decrement and reject
 *   3. Otherwise proceed
 *
 * Counters expire 25h after creation (one extra hour of grace so a
 * call landing right at midnight doesn't get caught in a TTL gap).
 *
 * When Upstash isn't configured (no REST URL/TOKEN), this module
 * falls back to the legacy "check then act" behavior — racy but
 * functional. Production should always have Upstash configured.
 *
 * Public API:
 *   reserveBudgetSlot({ businessId, budget }) →
 *     { allowed, count, limit, reason?, mode: 'atomic' | 'legacy' }
 *   getRemainingCalls({ businessId, budget }) → { count, limit }
 *
 * Counter key format: maroa:budget:<businessId>:<YYYYMMDD>
 * Counter value:      integer = calls made today
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
    console.warn('[budgetCounter] Upstash init failed — falling back to legacy check', e.message);
    return null;
  }
}

function todayKey(businessId) {
  // Use UTC date to align with most cost reports + match Anthropic billing.
  const d = new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `maroa:budget:${businessId}:${yyyymmdd}`;
}

/**
 * Atomically reserve one call slot for the business.
 * Returns { allowed: boolean, count: number, limit: number, mode: 'atomic'|'legacy' }.
 *
 * Per the design: increment first, check after, decrement if over.
 * This guarantees the limit is never exceeded even under concurrent
 * requests — Redis INCR is atomic.
 */
async function reserveBudgetSlot({ businessId, budget }) {
  if (!businessId || !budget) {
    return { allowed: true, count: 0, limit: Infinity, mode: 'noop' };
  }
  const limit = Number(budget.calls_per_day) || Infinity;
  if (!Number.isFinite(limit)) {
    return { allowed: true, count: 0, limit, mode: 'noop' };
  }

  const redis = getRedis();
  if (!redis) {
    // No Redis — return mode='legacy' so callers know to do the old
    // racy check via orchestration_logs.
    return { allowed: true, count: 0, limit, mode: 'legacy' };
  }

  const key = todayKey(businessId);
  try {
    // INCR atomically returns the new value. First call also EXPIRE-s
    // the key to 25 hours so it auto-cleans.
    const newCount = await redis.incr(key);
    if (newCount === 1) {
      // Brand new counter for this (business, day) — set TTL.
      await redis.expire(key, 25 * 60 * 60).catch(() => {
        /* soft-fail, TTL is optimization */
      });
    }
    if (newCount > limit) {
      // Over budget — undo the increment so we don't permanently
      // wedge this business. Subsequent calls in the same day will
      // continue to fail until the next UTC day rolls over.
      await redis.decr(key).catch(() => {
        /* best-effort */
      });
      return {
        allowed: false,
        count: newCount - 1,
        limit,
        reason: `Daily limit of ${limit} AI calls reached`,
        mode: 'atomic',
      };
    }
    return { allowed: true, count: newCount, limit, mode: 'atomic' };
  } catch (e) {
    // Redis error — soft-allow (better than blocking real customers
    // for an Upstash outage). The legacy orchestration_logs counter
    // remains as a secondary check via the caller's existing path.
    return { allowed: true, count: 0, limit, mode: 'redis_error', reason: e.message };
  }
}

/**
 * Read-only current count + limit. Use for dashboards or sanity
 * checks — does NOT increment.
 */
async function getRemainingCalls({ businessId, budget }) {
  if (!businessId || !budget) return { count: 0, limit: Infinity };
  const limit = Number(budget.calls_per_day) || Infinity;
  const redis = getRedis();
  if (!redis) return { count: 0, limit, mode: 'no_redis' };
  try {
    const val = await redis.get(todayKey(businessId));
    return { count: Number(val) || 0, limit, mode: 'atomic' };
  } catch {
    return { count: 0, limit, mode: 'redis_error' };
  }
}

module.exports = { reserveBudgetSlot, getRemainingCalls, todayKey };
