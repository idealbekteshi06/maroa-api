'use strict';

/**
 * Behavioral tests for the Paddle payment lifecycle
 * (services/paddle-webhook.js — extracted from server.js PIECE 5).
 *
 * These are money-path tests: signature/replay rejection, plan grant on
 * activation, churn de-arm on cancel/payment-failure, dunning self-heal,
 * refund downgrade, idempotent duplicate delivery, and the crash path
 * (500 + failed-commit + LRU evict so Paddle's retry re-provisions).
 *
 * Real collaborators used: services/paddle.verifyWebhookSignature (real HMAC
 * over real signed payloads) and lib/webhookEvents (real two-phase dedup)
 * backed by an in-memory PostgREST fake. Only I/O (db, email, WhatsApp, SSE,
 * loopback fetch) is faked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createPaddleWebhookHandler, buildPriceToPlanMap } = require('../services/paddle-webhook');

const SECRET = 'pdl_test_webhook_secret';
const BIZ_ID = '11111111-2222-4333-8444-555555555555';
const PRICE_TO_PLAN = buildPriceToPlanMap({
  starter: 'pri_starter',
  growth: 'pri_growth',
  agency: 'pri_agency',
});

let _eventSeq = 0;
const freshEventId = () => `ntf_${Date.now()}_${++_eventSeq}_${crypto.randomBytes(4).toString('hex')}`;

// ─── Paddle signature helper (matches services/paddle.js scheme) ────────────
function sign(bodyStr, { secret = SECRET, tsSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const h1 = crypto.createHmac('sha256', secret).update(`${tsSeconds}:${bodyStr}`).digest('hex');
  return `ts=${tsSeconds};h1=${h1}`;
}

// ─── In-memory PostgREST fake ────────────────────────────────────────────────
// Supports the filter shapes the handler + lib/webhookEvents actually use:
// `col=eq.value` conjunctions, with select/limit ignored.
function parseFilter(filter) {
  const conds = [];
  for (const part of String(filter || '').split('&')) {
    const [key, ...rest] = part.split('=');
    const val = rest.join('=');
    if (key === 'select' || key === 'limit' || key === 'order') continue;
    if (val.startsWith('eq.')) conds.push([key, decodeURIComponent(val.slice(3))]);
  }
  return (row) => conds.every(([k, v]) => String(row[k]) === v);
}

function makeDb({ businesses = [] } = {}) {
  const tables = {
    businesses: businesses.map((b) => ({ ...b })),
    webhook_events: [],
    usage_logs: [],
    onboarding_events: [],
  };
  const calls = { get: [], post: [], patch: [] };

  const sbGet = async (table, filter) => {
    calls.get.push({ table, filter });
    return (tables[table] || []).filter(parseFilter(filter)).map((r) => ({ ...r }));
  };
  const sbPost = async (table, row) => {
    calls.post.push({ table, row });
    if (table === 'webhook_events') {
      const dup = tables.webhook_events.find((r) => r.provider === row.provider && r.event_id === row.event_id);
      if (dup) throw new Error('409 duplicate key value violates unique constraint "webhook_events_pkey"');
    }
    (tables[table] = tables[table] || []).push({ ...row });
    return [{ ...row }];
  };
  const sbPatch = async (table, filter, patch) => {
    calls.patch.push({ table, filter, patch });
    const match = parseFilter(filter);
    const updated = [];
    for (const row of tables[table] || []) {
      if (match(row)) {
        Object.assign(row, patch);
        updated.push({ ...row });
      }
    }
    return updated;
  };

  return { tables, calls, sbGet, sbPost, sbPatch };
}

// ─── req/res fakes ───────────────────────────────────────────────────────────
function makeReq(bodyStr, { signature } = {}) {
  return {
    headers: signature === null ? {} : { 'paddle-signature': signature ?? sign(bodyStr) },
    body: Buffer.from(bodyStr),
    requestId: 'req_test',
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}

// ─── Handler harness ─────────────────────────────────────────────────────────
function makeHarness({ businesses, secret = SECRET, overrides = {} } = {}) {
  const db = makeDb({ businesses });
  const sent = { emails: [], whatsapp: [], sse: [], fetches: [] };
  const handler = createPaddleWebhookHandler({
    secret,
    priceToPlan: PRICE_TO_PLAN,
    sbGet: overrides.sbGet || db.sbGet,
    sbPost: overrides.sbPost || db.sbPost,
    sbPatch: overrides.sbPatch || db.sbPatch,
    sendEmail: async (to, subject, html) => void sent.emails.push({ to, subject, html }),
    sendWhatsApp: async (to, message) => void sent.whatsapp.push({ to, message }),
    sendSSE: (businessId, eventType, data) => void sent.sse.push({ businessId, eventType, data }),
    fetchImpl: (url, opts) => {
      sent.fetches.push({ url, opts });
      return Promise.resolve({ ok: true });
    },
    internalSecret: 'internal-secret',
    port: 3000,
    ...overrides.deps,
  });
  const deliver = async (event, reqOpts) => {
    const bodyStr = JSON.stringify(event);
    const res = makeRes();
    await handler(makeReq(bodyStr, reqOpts), res);
    return res;
  };
  return { db, sent, handler, deliver };
}

const paidBiz = (extra = {}) => ({
  id: BIZ_ID,
  plan: 'growth',
  email: 'owner@example.com',
  business_name: 'IBG Boost',
  is_active: true,
  paddle_subscription_id: 'sub_123',
  ...extra,
});

function activationEvent({ plan, priceId = 'pri_growth', businessId = BIZ_ID, eventId = freshEventId() } = {}) {
  return {
    notification_id: eventId,
    event_type: 'subscription.activated',
    data: {
      id: 'sub_123',
      customer_id: 'ctm_123',
      custom_data: { business_id: businessId, ...(plan ? { plan } : {}) },
      items: [{ price: { id: priceId } }],
    },
  };
}

// ═══ Security: secret / signature / replay / body ════════════════════════════

test('paddle webhook: 503 when PADDLE_WEBHOOK_SECRET is not configured', async () => {
  const h = makeHarness({ secret: '' });
  const res = await h.deliver(activationEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(h.db.calls.patch.length, 0);
});

test('paddle webhook: 400 when signature header is missing', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  const res = await h.deliver(activationEvent(), { signature: null });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_REQUEST');
  assert.equal(h.db.calls.patch.length, 0);
});

test('paddle webhook: 400 on invalid HMAC — no side effects', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  const bodyStr = JSON.stringify(activationEvent({ plan: 'agency' }));
  const res = makeRes();
  await h.handler(makeReq(bodyStr, { signature: sign(bodyStr, { secret: 'wrong-secret' }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  assert.equal(h.db.tables.businesses[0].plan, 'free'); // no grant
  assert.equal(h.sent.emails.length, 0);
});

test('paddle webhook: 400 on stale timestamp (replay > 5 min) even with valid HMAC', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  const bodyStr = JSON.stringify(activationEvent({ plan: 'agency' }));
  const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 min old
  const res = makeRes();
  await h.handler(makeReq(bodyStr, { signature: sign(bodyStr, { tsSeconds: staleTs }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_SIGNATURE');
  assert.equal(h.db.tables.businesses[0].plan, 'free');
});

test('paddle webhook: 400 on unparseable JSON body (valid signature)', async () => {
  const h = makeHarness();
  const bodyStr = '{not json';
  const res = makeRes();
  await h.handler(makeReq(bodyStr), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_JSON');
});

// ═══ subscription.activated — plan grant ═════════════════════════════════════

test('subscription.activated: grants plan, stores paddle ids, re-arms is_active, notifies', async () => {
  const h = makeHarness({
    businesses: [paidBiz({ plan: 'free', is_active: false, whatsapp_number: '+123', whatsapp_enabled: true })],
  });
  const res = await h.deliver(activationEvent({ plan: 'agency' }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'agency');
  assert.equal(biz.paddle_customer_id, 'ctm_123');
  assert.equal(biz.paddle_subscription_id, 'sub_123');
  assert.equal(biz.is_active, true); // dunning self-heal re-arm
  assert.equal(h.sent.emails.length, 1);
  assert.match(h.sent.emails[0].subject, /agency/);
  assert.equal(h.sent.whatsapp.length, 1);
  assert.deepEqual(h.sent.sse[0], { businessId: BIZ_ID, eventType: 'plan_upgraded', data: { plan: 'agency' } });
  // event committed processed
  assert.equal(h.db.tables.webhook_events[0].status, 'processed');
});

test('subscription.activated: resolves plan from price id when custom_data.plan absent', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  await h.deliver(activationEvent({ priceId: 'pri_agency' }));
  assert.equal(h.db.tables.businesses[0].plan, 'agency');
});

test('subscription.activated: unknown price id + no custom plan falls back to starter', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  await h.deliver(activationEvent({ priceId: 'pri_unknown' }));
  assert.equal(h.db.tables.businesses[0].plan, 'starter');
});

test('subscription.activated: Rule 4 — non-UUID business_id never touches the db, still ACKs 200', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  const res = await h.deliver(activationEvent({ plan: 'agency', businessId: 'businesses?id=neq.x' }));
  assert.equal(res.statusCode, 200);
  assert.equal(h.db.tables.businesses[0].plan, 'free');
  assert.equal(h.db.calls.patch.filter((c) => c.table === 'businesses').length, 0);
  assert.equal(h.sent.emails.length, 0);
});

test('subscription.activated: FIRST paid activation (free→growth) fires cold-start loopback + onboarding event', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  await h.deliver(activationEvent({ plan: 'growth' }));

  assert.equal(h.sent.fetches.length, 1);
  const f = h.sent.fetches[0];
  assert.equal(f.url, 'http://127.0.0.1:3000/webhook/cold-start-trigger');
  assert.equal(f.opts.headers['x-webhook-secret'], 'internal-secret');
  assert.deepEqual(JSON.parse(f.opts.body), {
    businessId: BIZ_ID,
    source: 'paddle_subscription_activated',
    plan: 'growth',
  });
  const onboarding = h.db.tables.onboarding_events;
  assert.equal(onboarding.length, 1);
  assert.equal(onboarding[0].event_type, 'cold_start_auto_triggered');
  assert.equal(onboarding[0].event_data.prior_plan, 'free');
});

test('subscription.activated: renewal (already growth) does NOT re-fire cold-start', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'growth' })] });
  await h.deliver(activationEvent({ plan: 'growth' }));
  assert.equal(h.sent.fetches.length, 0);
  assert.equal(h.db.tables.onboarding_events.length, 0);
  // but the plan grant + notification still happen
  assert.equal(h.sent.emails.length, 1);
});

// ═══ Idempotency — duplicate delivery ════════════════════════════════════════

test('duplicate notification_id: second delivery short-circuits with duplicate:true and no re-grant', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  const event = activationEvent({ plan: 'growth' });

  const first = await h.deliver(event);
  assert.deepEqual(first.body, { received: true });
  const patchesAfterFirst = h.db.calls.patch.filter((c) => c.table === 'businesses').length;
  const emailsAfterFirst = h.sent.emails.length;

  const second = await h.deliver(event);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { received: true, duplicate: true });
  assert.equal(h.db.calls.patch.filter((c) => c.table === 'businesses').length, patchesAfterFirst);
  assert.equal(h.sent.emails.length, emailsAfterFirst);
  assert.equal(h.sent.fetches.length, 1); // cold-start fired exactly once
});

// ═══ subscription.canceled — churn de-arm ════════════════════════════════════

test('subscription.canceled: downgrades to free AND sets is_active=false (stops cron cost-leak)', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  const res = await h.deliver({
    notification_id: freshEventId(),
    event_type: 'subscription.canceled',
    data: { id: 'sub_123', custom_data: { business_id: BIZ_ID } },
  });
  assert.equal(res.statusCode, 200);
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'free');
  assert.equal(biz.plan_price, 0);
  assert.equal(biz.is_active, false);
});

test('subscription.canceled: without custom_data falls back to paddle_subscription_id lookup', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'subscription.canceled',
    data: { id: 'sub_123' },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'free');
  assert.equal(biz.is_active, false);
});

// ═══ payment failure / past_due — dunning ════════════════════════════════════

for (const eventType of ['transaction.payment_failed', 'subscription.past_due']) {
  test(`${eventType}: downgrades to free + de-arms is_active`, async () => {
    const h = makeHarness({ businesses: [paidBiz()] });
    await h.deliver({
      notification_id: freshEventId(),
      event_type: eventType,
      data: { id: 'sub_123', custom_data: { business_id: BIZ_ID } },
    });
    const biz = h.db.tables.businesses[0];
    assert.equal(biz.plan, 'free');
    assert.equal(biz.plan_price, 0);
    assert.equal(biz.is_active, false);
  });
}

test('payment_failed: non-UUID business_id falls back to subscription_id lookup (Rule 4)', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'transaction.payment_failed',
    data: { id: 'txn_1', subscription_id: 'sub_123', custom_data: { business_id: 'not-a-uuid' } },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'free');
  assert.equal(biz.is_active, false);
});

test('dunning self-heal: payment_failed bricks the account, later activation re-arms it', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'growth' })] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'transaction.payment_failed',
    data: { id: 'sub_123', custom_data: { business_id: BIZ_ID } },
  });
  assert.equal(h.db.tables.businesses[0].is_active, false);
  assert.equal(h.db.tables.businesses[0].plan, 'free');

  // Card clears — Paddle re-sends subscription.activated
  await h.deliver(activationEvent({ plan: 'growth' }));
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'growth');
  assert.equal(biz.is_active, true);
});

// ═══ transaction.completed — accounting ══════════════════════════════════════

test('transaction.completed: writes a usage_logs accounting row', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'transaction.completed',
    data: { id: 'txn_1', custom_data: { business_id: BIZ_ID, plan: 'growth' } },
  });
  const logs = h.db.tables.usage_logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].user_id, BIZ_ID);
  assert.equal(logs[0].action, 'paddle_transaction');
  assert.equal(logs[0].plan_name, 'growth');
  assert.equal(logs[0].status, 'success');
});

// ═══ pause / resume ══════════════════════════════════════════════════════════

test('subscription.paused: keeps plan tier, flags paddle_subscription_status=paused', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'agency' })] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'subscription.paused',
    data: { id: 'sub_123', custom_data: { business_id: BIZ_ID } },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'agency'); // tier preserved
  assert.equal(biz.paddle_subscription_status, 'paused');
});

test('subscription.resumed: restores plan from price id and re-flags active (lookup by sub id)', async () => {
  const h = makeHarness({
    businesses: [paidBiz({ plan: 'agency', paddle_subscription_status: 'paused' })],
  });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'subscription.resumed',
    data: { id: 'sub_123', items: [{ price: { id: 'pri_agency' } }] }, // no custom_data
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'agency');
  assert.equal(biz.paddle_subscription_status, 'active');
});

// ═══ refunds ═════════════════════════════════════════════════════════════════

test('transaction.refunded (full): logs refund + downgrades to free', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'growth' })] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'transaction.refunded',
    data: {
      id: 'adj_1',
      action: 'refund',
      subscription_id: 'sub_123',
      items: [{ totals: { subtotal: 0 } }],
      custom_data: { business_id: BIZ_ID, plan: 'growth' },
    },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'free');
  assert.equal(biz.paddle_subscription_status, 'refunded');
  const logs = h.db.tables.usage_logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'paddle_refund');
  assert.equal(logs[0].status, 'refunded');
});

test('adjustment.created (partial refund): logs but keeps the plan', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'growth' })] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'adjustment.created',
    data: {
      id: 'adj_2',
      action: 'refund',
      items: [{ totals: { subtotal: 1500 } }], // money still on the txn → partial
      custom_data: { business_id: BIZ_ID, plan: 'growth' },
    },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'growth'); // plan preserved
  assert.equal(h.db.tables.usage_logs.length, 1);
  assert.equal(h.db.tables.usage_logs[0].action, 'paddle_refund');
});

// ═══ trials ══════════════════════════════════════════════════════════════════

test('subscription.trialing: grants plan with trialing status + trial_ends_at', async () => {
  const h = makeHarness({ businesses: [paidBiz({ plan: 'free' })] });
  await h.deliver({
    notification_id: freshEventId(),
    event_type: 'subscription.trialing',
    data: {
      id: 'sub_123',
      custom_data: { business_id: BIZ_ID, plan: 'growth' },
      current_billing_period: { ends_at: '2026-08-01T00:00:00Z' },
    },
  });
  const biz = h.db.tables.businesses[0];
  assert.equal(biz.plan, 'growth');
  assert.equal(biz.paddle_subscription_status, 'trialing');
  assert.equal(biz.trial_ends_at, '2026-08-01T00:00:00Z');
});

// ═══ unhandled / malformed events ════════════════════════════════════════════

test('unhandled event type: ACKs 200 with zero db writes beyond dedup bookkeeping', async () => {
  const h = makeHarness({ businesses: [paidBiz()] });
  const res = await h.deliver({
    notification_id: freshEventId(),
    event_type: 'business.updated',
    data: { id: 'biz_x' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(h.db.calls.patch.filter((c) => c.table === 'businesses').length, 0);
  assert.equal(h.db.tables.usage_logs.length, 0);
});

test('missing event_type/data: early no-op still ACKs 200 and commits processed', async () => {
  const h = makeHarness();
  const res = await h.deliver({ notification_id: freshEventId() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  assert.equal(h.db.tables.webhook_events[0].status, 'processed');
});

// ═══ Crash path — never ACK-200 an un-provisioned paid customer ══════════════

test('handler crash: 500 + event committed failed + LRU evicted so the retry re-provisions', async () => {
  const db = makeDb({ businesses: [paidBiz({ plan: 'free' })] });
  let failBusinessPatches = 1; // fail the FIRST businesses patch only
  const flakySbPatch = async (table, filter, patch) => {
    if (table === 'businesses' && failBusinessPatches > 0) {
      failBusinessPatches--;
      throw new Error('supabase 503: connection reset');
    }
    return db.sbPatch(table, filter, patch);
  };
  const h = makeHarness({ overrides: { sbGet: db.sbGet, sbPost: db.sbPost, sbPatch: flakySbPatch } });
  const event = activationEvent({ plan: 'growth' });

  // Attempt 1: db blip mid-provision → 500 so Paddle retries.
  const first = await h.deliver(event);
  assert.equal(first.statusCode, 500);
  assert.equal(first.body.error.code, 'HANDLER_ERROR');
  const whRow = db.tables.webhook_events.find((r) => r.event_id === event.notification_id);
  assert.equal(whRow.status, 'failed');
  assert.equal(db.tables.businesses[0].plan, 'free'); // grant did not land

  // Attempt 2: Paddle retries the SAME notification_id — must NOT be
  // swallowed as a duplicate (LRU evicted + failed row treated as first-time).
  const second = await h.deliver(event);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { received: true });
  assert.equal(db.tables.businesses[0].plan, 'growth'); // customer provisioned
  assert.equal(db.tables.businesses[0].is_active, true);
  assert.equal(whRow.status, 'processed');
});

// ═══ buildPriceToPlanMap ═════════════════════════════════════════════════════

test('buildPriceToPlanMap: maps configured ids, skips empty ones', () => {
  assert.deepEqual(buildPriceToPlanMap({ starter: 'a', growth: '', agency: 'c' }), {
    a: 'starter',
    c: 'agency',
  });
  assert.deepEqual(buildPriceToPlanMap(), {});
});

test('createPaddleWebhookHandler: throws without db helpers', () => {
  assert.throws(() => createPaddleWebhookHandler({ secret: 'x' }), /sbGet, sbPost and sbPatch are required/);
});
