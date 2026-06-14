'use strict';

// businessMemory unit tests — fast + network-free for the Stryker command
// runner (lib/businessMemory.js had 0% mutation kill: nothing exercised it).
//
// businessMemory hard-requires services/anthropic-memory (real HTTPS client)
// and reads ANTHROPIC_MEMORY_ENABLED at module load. So: a fake module is
// planted in require.cache BEFORE the first require, and each scenario
// re-requires lib/businessMemory.js fresh to reset the env gate + the
// module-level service/session singletons.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ── Plant the fake memory service module ─────────────────────────────────────
const fakeMemPath = require.resolve('../services/anthropic-memory');
let factoryImpl = () => {
  throw new Error('factoryImpl not configured for this test');
};
const factoryCalls = [];
require.cache[fakeMemPath] = {
  id: fakeMemPath,
  filename: fakeMemPath,
  path: path.dirname(fakeMemPath),
  loaded: true,
  children: [],
  exports: {
    createMemoryService(opts) {
      factoryCalls.push(opts);
      return factoryImpl(opts);
    },
  },
};

const bmPath = require.resolve('../lib/businessMemory');

function freshBusinessMemory(envValue) {
  if (envValue === undefined) delete process.env.ANTHROPIC_MEMORY_ENABLED;
  else process.env.ANTHROPIC_MEMORY_ENABLED = envValue;
  delete require.cache[bmPath];
  return require(bmPath);
}

function makeFakeService({ sessionId = 'sess-1', ensureError, appendError } = {}) {
  const calls = { ensure: [], append: [] };
  const svc = {
    async ensureSession(args) {
      calls.ensure.push(args);
      if (ensureError) throw ensureError;
      return { id: sessionId };
    },
    async appendFact(args) {
      calls.append.push(args);
      if (appendError) throw appendError;
      return { ok: true };
    },
  };
  return { calls, svc };
}

function makeLogger() {
  const warnings = [];
  return { warnings, warn: (...a) => warnings.push(a) };
}

// ── Env gate: which ANTHROPIC_MEMORY_ENABLED values turn the feature on ─────
test('businessMemory: enabled for 1/true/yes/on (case-insensitive)', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    const { svc } = makeFakeService();
    factoryImpl = () => svc;
    const bm = freshBusinessMemory(v).makeBusinessMemory({ apiKey: 'k' });
    assert.strictEqual(bm.enabled, true, `"${v}" should enable memory`);
  }
});

test('businessMemory: disabled values never construct the service', async () => {
  // "money" contains "on" and "11" contains "1" — anchored match must reject
  // both (kills anchor mutants on the enable regex).
  for (const v of [undefined, '', '0', 'false', 'off', 'money', '11']) {
    factoryImpl = () => {
      throw new Error('factory must not be called when disabled');
    };
    const before = factoryCalls.length;
    const bm = freshBusinessMemory(v).makeBusinessMemory({ apiKey: 'k' });
    assert.strictEqual(bm.enabled, false, `"${v}" should disable memory`);
    assert.strictEqual(factoryCalls.length, before, 'disabled gate must short-circuit before require');
    // Every method is a silent no-op.
    await bm.rememberApproval('biz-1', { id: 'd1' });
    await bm.rememberRejection('biz-1', { id: 'd1' }, 'why');
    await bm.rememberPreference('biz-1', 'tone', 'casual');
    assert.strictEqual(await bm.sessionIdFor('biz-1'), null);
  }
});

test('businessMemory: service init failure → warn + disabled, never throws', () => {
  factoryImpl = () => {
    throw new Error('boom at init');
  };
  const logger = makeLogger();
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k', logger });
  assert.strictEqual(bm.enabled, false);
  assert.strictEqual(logger.warnings.length, 1);
  const [scope, biz, msg, meta] = logger.warnings[0];
  assert.strictEqual(scope, 'business-memory');
  assert.strictEqual(biz, null);
  assert.strictEqual(msg, 'memory service init failed');
  assert.strictEqual(meta.error, 'boom at init');
});

// ── rememberApproval ─────────────────────────────────────────────────────────
test('businessMemory: rememberApproval appends an approval fact (importance 0.6)', async () => {
  const { calls, svc } = makeFakeService({ sessionId: 'sess-appr' });
  factoryImpl = (opts) => {
    assert.strictEqual(opts.apiKey, 'api-key-1');
    return svc;
  };
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'api-key-1' });

  await bm.rememberApproval('biz-1', {
    id: 'dec-9',
    agent_name: 'ad-optimizer',
    decision_type: 'scale',
    recommendation_text: 'Raise budget 20%',
  });

  assert.deepStrictEqual(calls.ensure, [{ businessId: 'biz-1', namespace: 'maroa-business' }]);
  assert.deepStrictEqual(calls.append, [
    {
      sessionId: 'sess-appr',
      fact: 'User approved decision dec-9 from ad-optimizer (scale). Was: "Raise budget 20%"',
      kind: 'approval',
      importance: 0.6,
    },
  ]);
});

test('businessMemory: rememberApproval fallbacks + 240-char truncation', async () => {
  const { calls, svc } = makeFakeService();
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });

  // No agent_name / decision_type / recommendation_text.
  await bm.rememberApproval('biz-1', { id: 'dec-1' });
  assert.strictEqual(calls.append[0].fact, 'User approved decision dec-1 from unknown agent (unknown type)');

  // Oversized recommendation_text is clamped to exactly 240 chars.
  const long = 'x'.repeat(300);
  await bm.rememberApproval('biz-1', { id: 'dec-2', recommendation_text: long });
  assert.ok(calls.append[1].fact.endsWith(`. Was: "${'x'.repeat(240)}"`));
  assert.ok(!calls.append[1].fact.includes('x'.repeat(241)));
});

test('businessMemory: rememberApproval no-ops without businessId or decision', async () => {
  const { calls, svc } = makeFakeService();
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });
  await bm.rememberApproval(null, { id: 'dec-1' });
  await bm.rememberApproval('biz-1', null);
  assert.strictEqual(calls.ensure.length, 0);
  assert.strictEqual(calls.append.length, 0);
});

// ── rememberRejection ────────────────────────────────────────────────────────
test('businessMemory: rememberRejection appends higher-importance rejection (0.85)', async () => {
  const { calls, svc } = makeFakeService({ sessionId: 'sess-rej' });
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });

  await bm.rememberRejection(
    'biz-2',
    { id: 'dec-3', agent_name: 'creative-engine', decision_type: 'refresh', recommendation_text: 'New hook' },
    '  too salesy  '
  );
  assert.deepStrictEqual(calls.append, [
    {
      sessionId: 'sess-rej',
      fact: 'User rejected decision dec-3 from creative-engine. Reason: too salesy Was: "New hook"',
      kind: 'rejection',
      importance: 0.85,
    },
  ]);
});

test('businessMemory: rememberRejection without reason says so explicitly', async () => {
  const { calls, svc } = makeFakeService();
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });
  await bm.rememberRejection('biz-2', { id: 'dec-4' });
  assert.strictEqual(calls.append[0].fact, 'User rejected decision dec-4 from unknown agent. No reason given.');
});

// ── rememberPreference ───────────────────────────────────────────────────────
test('businessMemory: rememberPreference stores kind=value at importance 0.9', async () => {
  const { calls, svc } = makeFakeService({ sessionId: 'sess-pref' });
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });

  await bm.rememberPreference('biz-3', 'posting_days', 'weekdays only');
  assert.deepStrictEqual(calls.append, [
    {
      sessionId: 'sess-pref',
      fact: 'Preference: posting_days = weekdays only',
      kind: 'preference',
      importance: 0.9,
    },
  ]);

  await bm.rememberPreference('biz-3', 'long', 'y'.repeat(300));
  assert.strictEqual(calls.append[1].fact, `Preference: long = ${'y'.repeat(240)}`);

  await bm.rememberPreference(null, 'tone', 'casual');
  assert.strictEqual(calls.append.length, 2, 'missing businessId must no-op');
});

// ── Session handling ─────────────────────────────────────────────────────────
test('businessMemory: session id cached per business, distinct per business', async () => {
  const { calls, svc } = makeFakeService({ sessionId: 'sess-cache' });
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });

  assert.strictEqual(await bm.sessionIdFor('biz-a'), 'sess-cache');
  assert.strictEqual(await bm.sessionIdFor('biz-a'), 'sess-cache');
  await bm.rememberPreference('biz-a', 'tone', 'casual');
  assert.strictEqual(calls.ensure.length, 1, 'same business reuses the cached session');

  await bm.sessionIdFor('biz-b');
  assert.strictEqual(calls.ensure.length, 2, 'new business creates its own session');
  assert.strictEqual(await bm.sessionIdFor(null), null);
});

test('businessMemory: ensureSession failure degrades to no-op (never blocks)', async () => {
  const { calls, svc } = makeFakeService({ ensureError: new Error('memory api down') });
  factoryImpl = () => svc;
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });

  assert.strictEqual(await bm.sessionIdFor('biz-x'), null);
  await bm.rememberApproval('biz-x', { id: 'dec-5' });
  assert.strictEqual(calls.append.length, 0);
});

test('businessMemory: ensureSession without id is not cached as a session', async () => {
  const calls = { ensure: 0 };
  factoryImpl = () => ({
    async ensureSession() {
      calls.ensure += 1;
      return {}; // no id
    },
    async appendFact() {
      throw new Error('must not append without a session id');
    },
  });
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k' });
  assert.strictEqual(await bm.sessionIdFor('biz-y'), null);
  assert.strictEqual(await bm.sessionIdFor('biz-y'), null);
  assert.strictEqual(calls.ensure, 2, 'id-less responses must not poison the cache');
});

test('businessMemory: appendFact failure is swallowed + warned per method', async () => {
  const { svc } = makeFakeService({ appendError: new Error('append 500') });
  factoryImpl = () => svc;
  const logger = makeLogger();
  const bm = freshBusinessMemory('1').makeBusinessMemory({ apiKey: 'k', logger });

  await bm.rememberApproval('biz-z', { id: 'd' });
  await bm.rememberRejection('biz-z', { id: 'd' }, 'r');
  await bm.rememberPreference('biz-z', 'k', 'v');

  const messages = logger.warnings.map((w) => w[2]);
  assert.deepStrictEqual(messages, [
    'rememberApproval failed',
    'rememberRejection failed',
    'rememberPreference failed',
  ]);
  for (const w of logger.warnings) {
    assert.strictEqual(w[0], 'business-memory');
    assert.strictEqual(w[1], 'biz-z');
    assert.strictEqual(w[3].error, 'append 500');
  }
});
