'use strict';

// webhookEvents unit tests — fast + network-free for the Stryker command
// runner (lib/webhookEvents.js scored 0.35%: only the slow e2e publish
// pipeline touched it). All Supabase access is via injected fakes.
//
// The module keeps a process-global LRU of seen (provider, eventId) pairs,
// so every test uses its own unique ids; the capacity-eviction test runs
// LAST because it flushes ~1000 older entries out of that shared LRU.

const test = require('node:test');
const assert = require('node:assert');

const {
  markProcessed,
  commitProcessed,
  forgetEvent,
  middleware,
  EVENT_ID_EXTRACTORS,
} = require('../lib/webhookEvents');

function makeLogger() {
  return {
    infos: [],
    warnings: [],
    errors: [],
    info(...a) {
      this.infos.push(a);
    },
    warn(...a) {
      this.warnings.push(a);
    },
    error(...a) {
      this.errors.push(a);
    },
  };
}

function makeRes() {
  const listeners = {};
  return {
    statusCode: 200,
    jsonBody: undefined,
    on(evt, cb) {
      (listeners[evt] = listeners[evt] || []).push(cb);
    },
    emit(evt) {
      for (const cb of listeners[evt] || []) cb();
    },
    json(x) {
      this.jsonBody = x;
      return this;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// ── LRU short-circuit ────────────────────────────────────────────────────────
// FIRST test on purpose: with an empty LRU, a broken eviction comparator
// (size >= MAX mutated to <) evicts on every insert — both re-checks below
// would then miss the cache and hit the DB.
test('markProcessed: LRU retains multiple recent events under capacity', async () => {
  const sbPost = async () => [{}];
  const a = await markProcessed({ provider: 'lru', eventId: 'a', sbPost });
  const b = await markProcessed({ provider: 'lru', eventId: 'b', sbPost });
  assert.deepStrictEqual(a, { firstTime: true, source: 'db' });
  assert.deepStrictEqual(b, { firstTime: true, source: 'db' });
  assert.deepStrictEqual(await markProcessed({ provider: 'lru', eventId: 'a', sbPost }), {
    firstTime: false,
    source: 'lru',
  });
  assert.deepStrictEqual(await markProcessed({ provider: 'lru', eventId: 'b', sbPost }), {
    firstTime: false,
    source: 'lru',
  });
});

test('markProcessed: duplicate short-circuits before the DB; forgetEvent re-arms', async () => {
  let postCount = 0;
  const sbPost = async () => {
    postCount += 1;
    return [{}];
  };
  await markProcessed({ provider: 'p1', eventId: 'evt-dup', sbPost });
  assert.strictEqual(postCount, 1);

  const dup = await markProcessed({ provider: 'p1', eventId: 'evt-dup', sbPost });
  assert.deepStrictEqual(dup, { firstTime: false, source: 'lru' });
  assert.strictEqual(postCount, 1, 'duplicate must not touch the DB');

  forgetEvent('p1', 'evt-dup');
  const again = await markProcessed({ provider: 'p1', eventId: 'evt-dup', sbPost });
  assert.deepStrictEqual(again, { firstTime: true, source: 'db' });
  assert.strictEqual(postCount, 2);
  // Guarded no-ops must not throw.
  forgetEvent(null, 'evt-dup');
  forgetEvent('p1');
});

// ── Provider extractors ──────────────────────────────────────────────────────
test('EVENT_ID_EXTRACTORS: per-provider extraction + fallback priority', () => {
  const X = EVENT_ID_EXTRACTORS;
  assert.strictEqual(X.paddle({ notification_id: 'n1', event_id: 'e1', data: { id: 'd1' } }), 'n1');
  assert.strictEqual(X.paddle({ event_id: 'e1', data: { id: 'd1' } }), 'e1');
  assert.strictEqual(X.paddle({ data: { id: 'd1' } }), 'd1');
  assert.strictEqual(X.paddle(null), undefined);

  assert.strictEqual(X.stripe({ id: 'evt_1' }), 'evt_1');
  assert.strictEqual(X.stripe(undefined), undefined);

  assert.strictEqual(X.meta({ entry: [{ id: 'pg1', time: 1718000000 }] }), 'pg1:1718000000');
  assert.strictEqual(X.meta({ entry: [] }), null);
  assert.strictEqual(X.meta({}), null);

  assert.strictEqual(X.higgsfield({ request_id: 'r1', job_id: 'j1' }), 'r1');
  assert.strictEqual(X.higgsfield({ job_id: 'j1' }), 'j1');

  assert.strictEqual(X.ayrshare({ id: 'a1', event_id: 'e2' }), 'a1');
  assert.strictEqual(X.ayrshare({ event_id: 'e2' }), 'e2');

  assert.strictEqual(X.inngest({ id: 'i1', event: { id: 'i2' } }), 'i1');
  assert.strictEqual(X.inngest({ event: { id: 'i2' } }), 'i2');

  assert.strictEqual(X.google({ message: { messageId: 'm1' } }), 'm1');
  assert.strictEqual(X.google({}), undefined);
});

// ── markProcessed: insert + guard rails ──────────────────────────────────────
test('markProcessed: first delivery inserts a received row (event_id stringified)', async () => {
  const posts = [];
  const sbPost = async (table, body) => {
    posts.push({ table, body });
    return [{ id: 1 }];
  };
  const r = await markProcessed({ provider: 'paddle', eventId: 12345, sbPost });
  assert.deepStrictEqual(r, { firstTime: true, source: 'db' });
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].table, 'webhook_events');
  assert.strictEqual(posts[0].body.provider, 'paddle');
  assert.strictEqual(posts[0].body.event_id, '12345');
  assert.strictEqual(posts[0].body.status, 'received');
  assert.ok(!Number.isNaN(Date.parse(posts[0].body.received_at)));
});

test('markProcessed: missing provider or eventId → process the event, never insert', async () => {
  let postCount = 0;
  const sbPost = async () => {
    postCount += 1;
    return [{}];
  };
  assert.deepStrictEqual(await markProcessed({ eventId: 'x', sbPost }), {
    firstTime: true,
    reason: 'missing provider or eventId',
  });
  assert.deepStrictEqual(await markProcessed({ provider: 'p', sbPost }), {
    firstTime: true,
    reason: 'missing provider or eventId',
  });
  assert.strictEqual(postCount, 0);
});

test('markProcessed: no sbPost → soft-allow', async () => {
  assert.deepStrictEqual(await markProcessed({ provider: 'soft', eventId: 'no-post-1' }), {
    firstTime: true,
    reason: 'sbPost not available',
  });
});

test('markProcessed: non-duplicate DB error fails closed (rethrows + logs)', async () => {
  const logger = makeLogger();
  await assert.rejects(
    () =>
      markProcessed({
        provider: 'px',
        eventId: 'boom-1',
        sbPost: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        logger,
      }),
    /ECONNREFUSED/
  );
  assert.strictEqual(logger.errors.length, 1);
  assert.strictEqual(logger.errors[0][2], 'idempotency check failed — failing closed');
});

// ── Two-phase conflict recovery (PK collision → re-read status) ──────────────
const dupErr = () => {
  throw new Error('PostgREST: Duplicate key value violates unique constraint'); // mixed case on purpose
};

test('markProcessed: PK conflict without sbGet → conservative duplicate', async () => {
  const r = await markProcessed({ provider: 'px', eventId: 'c-noread', sbPost: async () => dupErr() });
  assert.deepStrictEqual(r, { firstTime: false, source: 'db_conflict_no_read' });
});

test('markProcessed: HTTP 409 message also routes to conflict recovery', async () => {
  const r = await markProcessed({
    provider: 'px',
    eventId: 'c-409',
    sbPost: async () => {
      throw new Error('request failed with status 409');
    },
  });
  assert.deepStrictEqual(r, { firstTime: false, source: 'db_conflict_no_read' });
});

test('markProcessed: empty/null insert result is treated as a conflict', async () => {
  const r1 = await markProcessed({ provider: 'px', eventId: 'c-empty', sbPost: async () => [] });
  assert.deepStrictEqual(r1, { firstTime: false, source: 'db_conflict_no_read' });
  const r2 = await markProcessed({
    provider: 'px',
    eventId: 'c-null',
    sbPost: async () => null,
    sbGet: async () => [],
  });
  assert.deepStrictEqual(r2, { firstTime: true, source: 'db_no_row_after_conflict' });
});

test('markProcessed: conflict + processed row → true duplicate (exact re-read filter)', async () => {
  const gets = [];
  const sbGet = async (table, filter) => {
    gets.push({ table, filter });
    return [{ status: 'processed', received_at: new Date().toISOString() }];
  };
  const r = await markProcessed({ provider: 'px', eventId: 'e&v=1', sbPost: async () => dupErr(), sbGet });
  assert.deepStrictEqual(r, { firstTime: false, source: 'db_processed' });
  assert.strictEqual(gets[0].table, 'webhook_events');
  // eventId is encoded so `&`/`=` cannot break out of the PostgREST filter.
  assert.strictEqual(gets[0].filter, 'provider=eq.px&event_id=eq.e%26v%3D1&select=status,received_at&limit=1');
});

test('markProcessed: conflict + failed row → reset to received and re-run handler', async () => {
  const patches = [];
  const sbGet = async () => [{ status: 'failed', received_at: new Date().toISOString() }];
  const sbPatch = async (table, filter, body) => {
    patches.push({ table, filter, body });
  };
  const r = await markProcessed({ provider: 'px', eventId: 'c-failed', sbPost: async () => dupErr(), sbGet, sbPatch });
  assert.deepStrictEqual(r, { firstTime: true, source: 'db_retry_after_failure' });
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].table, 'webhook_events');
  assert.strictEqual(patches[0].filter, 'provider=eq.px&event_id=eq.c-failed');
  assert.strictEqual(patches[0].body.status, 'received');
  assert.strictEqual(patches[0].body.error, null);
  assert.ok(!Number.isNaN(Date.parse(patches[0].body.received_at)));
});

test('markProcessed: conflict + failed row without sbPatch still allows the retry', async () => {
  const sbGet = async () => [{ status: 'failed', received_at: new Date().toISOString() }];
  const r = await markProcessed({ provider: 'px', eventId: 'c-failed-nopatch', sbPost: async () => dupErr(), sbGet });
  assert.deepStrictEqual(r, { firstTime: true, source: 'db_retry_after_failure' });
});

test('markProcessed: conflict + in-flight row → duplicate until it goes stale (>5min)', async () => {
  const ageMin = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

  const fresh = await markProcessed({
    provider: 'px',
    eventId: 'c-inflight-0m',
    sbPost: async () => dupErr(),
    sbGet: async () => [{ status: 'received', received_at: ageMin(0) }],
  });
  assert.deepStrictEqual(fresh, { firstTime: false, source: 'db_in_flight' });

  const fourMin = await markProcessed({
    provider: 'px',
    eventId: 'c-inflight-4m',
    sbPost: async () => dupErr(),
    sbGet: async () => [{ status: 'received', received_at: ageMin(4) }],
  });
  assert.deepStrictEqual(fourMin, { firstTime: false, source: 'db_in_flight' });

  const patches = [];
  const stale = await markProcessed({
    provider: 'px',
    eventId: 'c-inflight-6m',
    sbPost: async () => dupErr(),
    sbGet: async () => [{ status: 'received', received_at: ageMin(6) }],
    sbPatch: async (table, filter, body) => {
      patches.push({ filter, body });
    },
  });
  assert.deepStrictEqual(stale, { firstTime: true, source: 'db_stale_pending_recovered' });
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].filter, 'provider=eq.px&event_id=eq.c-inflight-6m');
  assert.strictEqual(patches[0].body.status, 'received');
  assert.ok(!('error' in patches[0].body), 'stale recovery does not clear the error column');
});

test('markProcessed: re-read failure → conservative duplicate', async () => {
  const logger = makeLogger();
  const r = await markProcessed({
    provider: 'px',
    eventId: 'c-readfail',
    sbPost: async () => dupErr(),
    sbGet: async () => {
      throw new Error('read timeout');
    },
    logger,
  });
  assert.deepStrictEqual(r, { firstTime: false, source: 'db_check_error' });
  assert.strictEqual(logger.warnings.length, 1);
});

// ── commitProcessed (phase 2) ────────────────────────────────────────────────
test('commitProcessed: patches the row with outcome status (encoded filter, error clamp)', async () => {
  const patches = [];
  const sbPatch = async (table, filter, body) => {
    patches.push({ table, filter, body });
  };

  await commitProcessed({ provider: 'paddle', eventId: 'e&x', status: 'processed', sbPatch });
  assert.strictEqual(patches[0].table, 'webhook_events');
  assert.strictEqual(patches[0].filter, 'provider=eq.paddle&event_id=eq.e%26x');
  assert.strictEqual(patches[0].body.status, 'processed');
  assert.ok(!Number.isNaN(Date.parse(patches[0].body.processed_at)));
  assert.ok(!('error' in patches[0].body), 'no error key on success');

  await commitProcessed({ provider: 'paddle', eventId: 42, status: 'failed', sbPatch, error: 'z'.repeat(600) });
  assert.strictEqual(patches[1].filter, 'provider=eq.paddle&event_id=eq.42');
  assert.strictEqual(patches[1].body.status, 'failed');
  assert.strictEqual(patches[1].body.error, 'z'.repeat(500), 'error clamped to 500 chars');
});

test('commitProcessed: best-effort — patch failure warns, missing sbPatch noops', async () => {
  const logger = makeLogger();
  await commitProcessed({
    provider: 'paddle',
    eventId: 'e1',
    status: 'processed',
    sbPatch: async () => {
      throw new Error('db down');
    },
    logger,
    responseStatus: 200,
  });
  assert.strictEqual(logger.warnings.length, 1);
  assert.strictEqual(logger.warnings[0][3].error, 'db down');
  assert.strictEqual(logger.warnings[0][3].response_status, 200);

  await commitProcessed({ provider: 'paddle', eventId: 'e1', status: 'processed' }); // no sbPatch — must not throw
});

// ── middleware ───────────────────────────────────────────────────────────────
test('middleware: unknown provider warns at mount and passes requests through', async () => {
  const logger = makeLogger();
  let postCount = 0;
  const mw = middleware({
    provider: 'smoke-signals',
    sbPost: async () => {
      postCount += 1;
      return [{}];
    },
    logger,
  });
  assert.strictEqual(logger.warnings.length, 1);
  assert.strictEqual(logger.warnings[0][2], 'no extractor for provider');
  assert.deepStrictEqual(logger.warnings[0][3], { provider: 'smoke-signals' });

  const res = makeRes();
  let nextCalled = false;
  await mw({ body: { id: 'whatever' } }, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(postCount, 0, 'no extractor → no dedup write');
  assert.strictEqual(res.jsonBody, undefined);
});

test('middleware: body without an extractable id passes through undeduped', async () => {
  let postCount = 0;
  const mw = middleware({
    provider: 'paddle',
    sbPost: async () => {
      postCount += 1;
      return [{}];
    },
  });
  let nextCalled = false;
  await mw({ body: {} }, makeRes(), () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(postCount, 0);
});

test('middleware: custom getEventId overrides the built-in extractor', async () => {
  const posts = [];
  const mw = middleware({
    provider: 'paddle',
    getEventId: (body) => body.custom_key,
    sbPost: async (table, body) => {
      posts.push(body);
      return [{}];
    },
  });
  await mw({ body: { custom_key: 'custom-1', notification_id: 'builtin-1' } }, makeRes(), () => {});
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].event_id, 'custom-1');
});

test('middleware: first delivery runs handler; finish status drives phase-2 commit', async () => {
  // statusCode → expected phase-2 status, covering the 2xx/3xx vs 4xx/5xx boundary.
  const cases = [
    [200, 'processed'],
    [399, 'processed'],
    [199, 'failed'],
    [400, 'failed'],
    [500, 'failed'],
  ];
  for (const [code, expected] of cases) {
    const patches = [];
    const mw = middleware({
      provider: 'stripe',
      sbPost: async () => [{}],
      sbPatch: async (table, filter, body) => {
        patches.push({ filter, body });
      },
    });
    const res = makeRes();
    let nextCalled = false;
    await mw({ body: { id: `evt-fin-${code}` }, path: '/webhook/stripe' }, res, () => {
      nextCalled = true;
    });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.jsonBody, undefined, 'first delivery must not be answered as duplicate');

    res.statusCode = code;
    res.emit('finish');
    await flush();
    assert.strictEqual(patches.length, 1, `HTTP ${code} should commit exactly once`);
    assert.strictEqual(patches[0].filter, `provider=eq.stripe&event_id=eq.evt-fin-${code}`);
    assert.strictEqual(patches[0].body.status, expected, `HTTP ${code} → ${expected}`);
    assert.ok(!('error' in patches[0].body));

    res.emit('close'); // close after finish must not double-commit
    await flush();
    assert.strictEqual(patches.length, 1);
  }
});

test('middleware: connection closed before finish → failed so the provider retries', async () => {
  const patches = [];
  const mw = middleware({
    provider: 'stripe',
    sbPost: async () => [{}],
    sbPatch: async (table, filter, body) => {
      patches.push(body);
    },
  });
  const res = makeRes();
  await mw({ body: { id: 'evt-closed-1' }, path: '/webhook/stripe' }, res, () => {});

  res.emit('close');
  await flush();
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].status, 'failed');
  assert.strictEqual(patches[0].error, 'connection_closed_before_handler_finished');

  res.emit('finish'); // late finish must not overwrite the failed commit
  await flush();
  assert.strictEqual(patches.length, 1);
});

test('middleware: duplicate delivery answers 200-duplicate without running the handler', async () => {
  const logger = makeLogger();
  const mw = middleware({ provider: 'stripe', sbPost: async () => [{}], logger });
  const req = { body: { id: 'evt-mw-dup' }, path: '/webhook/stripe-webhook', requestId: 'rid-7' };

  await mw(req, makeRes(), () => {});

  const res2 = makeRes();
  let nextCalled = false;
  await mw(req, res2, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, false);
  assert.deepStrictEqual(res2.jsonBody, { received: true, duplicate: true, request_id: 'rid-7' });
  assert.strictEqual(logger.infos.length, 1);
  assert.strictEqual(logger.infos[0][0], '/webhook/stripe-webhook');
  assert.deepStrictEqual(logger.infos[0][3], { provider: 'stripe', event_id: 'evt-mw-dup' });
});

// ── LRU capacity eviction — keep LAST: floods the shared in-process cache ────
test('markProcessed: LRU evicts the oldest entry at capacity (1000), keeps recent', async () => {
  const sbPost = async () => [{}];
  await markProcessed({ provider: 'evict', eventId: 'k0', sbPost });
  for (let i = 1; i <= 1000; i++) {
    await markProcessed({ provider: 'evict', eventId: `k${i}`, sbPost });
  }
  // k0 fell out of the 1000-entry cap → its retry hits the DB path again.
  assert.deepStrictEqual(await markProcessed({ provider: 'evict', eventId: 'k0', sbPost }), {
    firstTime: true,
    source: 'db',
  });
  // The most recent key is still short-circuited in-process.
  assert.deepStrictEqual(await markProcessed({ provider: 'evict', eventId: 'k1000', sbPost }), {
    firstTime: false,
    source: 'lru',
  });
});
