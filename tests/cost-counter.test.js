'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getMonthlyCostUsd, addMonthlyCostUsd, __setRedisForTest } = require('../lib/costCounter');

// Minimal in-memory Redis fake implementing only what costCounter uses.
function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v, opts = {}) {
      if (opts.nx && store.has(k)) return null; // NX: only set if absent
      store.set(k, v);
      return 'OK';
    },
    async exists(k) {
      return store.has(k) ? 1 : 0;
    },
    async incrbyfloat(k, by) {
      const next = (Number(store.get(k)) || 0) + Number(by);
      store.set(k, next);
      return next;
    },
    async expire() {
      return 1;
    },
  };
}

test('costCounter: seeds from DB on first read, then serves atomically', async () => {
  const redis = makeFakeRedis();
  __setRedisForTest(redis);
  let seedCalls = 0;
  const seedFromDb = async () => {
    seedCalls += 1;
    return 42.5;
  };
  const biz = '11111111-1111-4111-8111-111111111111';

  const first = await getMonthlyCostUsd({ businessId: biz, seedFromDb });
  assert.equal(first.usedUsd, 42.5);
  assert.equal(first.mode, 'seeded');

  // Second read hits the cached counter — no second DB seed.
  const second = await getMonthlyCostUsd({ businessId: biz, seedFromDb });
  assert.equal(second.usedUsd, 42.5);
  assert.equal(second.mode, 'atomic');
  assert.equal(seedCalls, 1, 'DB seed runs at most once per month per business');

  __setRedisForTest(null);
});

test('costCounter: addMonthlyCostUsd increments a seeded counter, skips an unseeded one', async () => {
  const redis = makeFakeRedis();
  __setRedisForTest(redis);
  const biz = '22222222-2222-4222-8222-222222222222';

  // Not seeded yet → add is a no-op (cost is already in the DB; the next gate
  // read will seed a sum that includes it, so we must not start from just this).
  const skipped = await addMonthlyCostUsd({ businessId: biz, costUsd: 5 });
  assert.equal(skipped.mode, 'not_seeded_skip');

  // Seed, then add accumulates.
  await getMonthlyCostUsd({ businessId: biz, seedFromDb: async () => 10 });
  const added = await addMonthlyCostUsd({ businessId: biz, costUsd: 3.25 });
  assert.equal(added.mode, 'atomic');
  assert.equal(added.usedUsd, 13.25);

  const read = await getMonthlyCostUsd({ businessId: biz, seedFromDb: async () => 999 });
  assert.equal(read.usedUsd, 13.25, 'reads reflect accumulated cost, not a re-seed');

  __setRedisForTest(null);
});

test('costCounter: no-redis returns no_redis so costGuard falls back to the DB sum', async () => {
  __setRedisForTest(null); // force the no-redis branch
  const r = await getMonthlyCostUsd({ businessId: '33333333-3333-4333-8333-333333333333', seedFromDb: async () => 1 });
  assert.equal(r.mode, 'no_redis');
  const a = await addMonthlyCostUsd({ businessId: '33333333-3333-4333-8333-333333333333', costUsd: 1 });
  assert.equal(a.mode, 'no_redis');
});

test('costCounter: concurrent seeders converge on one value (NX)', async () => {
  const redis = makeFakeRedis();
  __setRedisForTest(redis);
  const biz = '44444444-4444-4444-8444-444444444444';
  // Two racing seeds with different DB sums; NX means the first winner sticks.
  const [a, b] = await Promise.all([
    getMonthlyCostUsd({ businessId: biz, seedFromDb: async () => 100 }),
    getMonthlyCostUsd({ businessId: biz, seedFromDb: async () => 200 }),
  ]);
  assert.equal(a.usedUsd, b.usedUsd, 'both readers see the same seeded value');
  __setRedisForTest(null);
});
