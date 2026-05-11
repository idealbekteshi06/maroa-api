'use strict';

/**
 * tests/budget-counter.test.js
 *
 * Verifies lib/budgetCounter.js — atomic per-business daily AI-call
 * budget counter. Critical security/cost path: races here mean budget
 * gets exceeded.
 *
 * No Redis = legacy mode. Tests verify both paths:
 *   - mode='legacy' when UPSTASH_REDIS_REST_URL is unset
 *   - mode='atomic' when a fake Redis client is wired in
 *   - mode='redis_error' when Redis throws
 */

const test = require('node:test');
const assert = require('node:assert');

// Clear cached redis client before each test by manipulating env.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Bust the require cache so we start fresh
delete require.cache[require.resolve('../lib/budgetCounter')];
const bc = require('../lib/budgetCounter');

const BUSINESS_ID = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';
const GROWTH_BUDGET = { calls_per_day: 100, max_tokens_per_call: 2000 };

test('todayKey: deterministic format for same day, different per business', () => {
  const k1 = bc.todayKey('biz-1');
  const k2 = bc.todayKey('biz-2');
  const k3 = bc.todayKey('biz-1');
  assert.match(k1, /^maroa:budget:biz-1:\d{8}$/);
  assert.match(k2, /^maroa:budget:biz-2:\d{8}$/);
  assert.strictEqual(k1, k3, 'same business same day → same key');
  assert.notStrictEqual(k1, k2, 'different business → different key');
});

test('reserveBudgetSlot: returns mode=noop on missing businessId', async () => {
  const r = await bc.reserveBudgetSlot({ businessId: null, budget: GROWTH_BUDGET });
  assert.strictEqual(r.mode, 'noop');
  assert.strictEqual(r.allowed, true);
});

test('reserveBudgetSlot: returns mode=noop on missing budget', async () => {
  const r = await bc.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: null });
  assert.strictEqual(r.mode, 'noop');
  assert.strictEqual(r.allowed, true);
});

test('reserveBudgetSlot: mode=legacy when Upstash not configured', async () => {
  // Ensure clean env
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  // Bust cache
  delete require.cache[require.resolve('../lib/budgetCounter')];
  const bcFresh = require('../lib/budgetCounter');
  const r = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: GROWTH_BUDGET });
  assert.strictEqual(r.mode, 'legacy');
  assert.strictEqual(r.allowed, true, 'legacy mode soft-allows — caller does the racy check');
});

test('reserveBudgetSlot: budget with infinite limit returns mode=noop', async () => {
  const r = await bc.reserveBudgetSlot({
    businessId: BUSINESS_ID,
    budget: { calls_per_day: Infinity, max_tokens_per_call: 2000 },
  });
  assert.strictEqual(r.mode, 'noop');
  assert.strictEqual(r.allowed, true);
});

test('reserveBudgetSlot: non-numeric calls_per_day returns mode=noop', async () => {
  const r = await bc.reserveBudgetSlot({
    businessId: BUSINESS_ID,
    budget: { calls_per_day: 'unlimited', max_tokens_per_call: 2000 },
  });
  assert.strictEqual(r.mode, 'noop');
});

test('getRemainingCalls: returns 0 count + Infinity limit when no budget', async () => {
  const r = await bc.getRemainingCalls({ businessId: null, budget: null });
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.limit, Infinity);
});

test('getRemainingCalls: returns no_redis mode when Upstash not configured', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete require.cache[require.resolve('../lib/budgetCounter')];
  const bcFresh = require('../lib/budgetCounter');
  const r = await bcFresh.getRemainingCalls({ businessId: BUSINESS_ID, budget: GROWTH_BUDGET });
  assert.strictEqual(r.mode, 'no_redis');
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.limit, 100);
});

// ─── Atomic-mode tests with a fake Redis client ────────────────────────

test('reserveBudgetSlot: mode=atomic increments and allows under limit', async () => {
  // Stub a fake @upstash/redis module
  const fakeRedis = {
    counter: new Map(),
    async incr(key) {
      const n = (this.counter.get(key) || 0) + 1;
      this.counter.set(key, n);
      return n;
    },
    async decr(key) {
      const n = (this.counter.get(key) || 0) - 1;
      this.counter.set(key, n);
      return n;
    },
    async expire() {
      return 1;
    },
    async get(key) {
      return this.counter.get(key) || null;
    },
  };

  // Inject the fake by replacing the Redis class
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === '@upstash/redis') {
      return {
        Redis: function () {
          return fakeRedis;
        },
      };
    }
    return origLoad.apply(this, [request, ...args]);
  };

  // Force env vars + cache bust
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete require.cache[require.resolve('../lib/budgetCounter')];

  try {
    const bcFresh = require('../lib/budgetCounter');
    const r1 = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: { calls_per_day: 3 } });
    assert.strictEqual(r1.mode, 'atomic');
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.count, 1);

    const r2 = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: { calls_per_day: 3 } });
    assert.strictEqual(r2.count, 2);
    assert.strictEqual(r2.allowed, true);

    const r3 = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: { calls_per_day: 3 } });
    assert.strictEqual(r3.count, 3);
    assert.strictEqual(r3.allowed, true);

    // 4th call should DECR and reject — over the limit
    const r4 = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: { calls_per_day: 3 } });
    assert.strictEqual(r4.allowed, false);
    assert.match(r4.reason, /Daily limit/);
  } finally {
    Module._load = origLoad;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete require.cache[require.resolve('../lib/budgetCounter')];
  }
});

test('reserveBudgetSlot: redis_error mode soft-allows on Redis exception', async () => {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === '@upstash/redis') {
      return {
        Redis: function () {
          return {
            async incr() {
              throw new Error('redis connection refused');
            },
            async decr() {
              return 0;
            },
            async expire() {
              return 1;
            },
            async get() {
              return null;
            },
          };
        },
      };
    }
    return origLoad.apply(this, [request, ...args]);
  };

  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete require.cache[require.resolve('../lib/budgetCounter')];

  try {
    const bcFresh = require('../lib/budgetCounter');
    const r = await bcFresh.reserveBudgetSlot({ businessId: BUSINESS_ID, budget: { calls_per_day: 100 } });
    assert.strictEqual(r.mode, 'redis_error');
    assert.strictEqual(r.allowed, true, 'Redis outage soft-allows so we never block real customers');
    assert.match(r.reason, /redis connection refused/);
  } finally {
    Module._load = origLoad;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete require.cache[require.resolve('../lib/budgetCounter')];
  }
});
