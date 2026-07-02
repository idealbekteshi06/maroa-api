'use strict';

/**
 * tests/stream-ticket.test.js
 *
 * SSE stream-ticket auth — the EventSource path for /webhook/dashboard-events
 * and /webhook/wf15-stream/:id. Browsers cannot attach an Authorization
 * header to an EventSource, so the dashboard mints a 60s HMAC ticket via
 * POST /api/stream-ticket and appends it as ?ticket=.
 *
 * Covers:
 *   - lib/streamTicket sign/verify: roundtrip, expiry, future-dating,
 *     tampered payload + signature, wrong secret, non-UUID fields
 *   - domain separation from lib/oauthState (shared secret, no cross-accept)
 *   - middleware/requireAuthOrWebhookSecret ?ticket= branch: GET-only,
 *     allowlist-only, business_id binding, hard-401 on invalid
 *   - routes/stream-ticket mint endpoint: ownership, validation, no-secret
 */

// The middleware reads its secrets from process.env at require time.
process.env.N8N_WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
delete process.env.STREAM_TICKET_SECRET;

const test = require('node:test');
const assert = require('node:assert');

const { signStreamTicket, verifyStreamTicket, STREAM_TICKET_TTL_MS } = require('../lib/streamTicket');
const { signOAuthState, verifyOAuthState } = require('../lib/oauthState');
const { requireAuthOrWebhookSecret } = require('../middleware/requireAuthOrWebhookSecret');

const SECRET = 'test-webhook-secret-0123456789';
const OTHER_SECRET = 'completely-different-secret-xyz';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MSG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeReq({
  method = 'GET',
  originalUrl = '/webhook/dashboard-events',
  query = {},
  headers = {},
  body = {},
} = {}) {
  return {
    method,
    originalUrl,
    query,
    body,
    headers,
    path: originalUrl.split('?')[0],
    get(name) {
      const k = String(name).toLowerCase();
      return headers[k] != null ? headers[k] : headers[name];
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

function apiError(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// ─── lib/streamTicket: sign + verify ───────────────────────────────────────

test('ticket: sign → verify roundtrip returns the bound identity', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const v = verifyStreamTicket(ticket, SECRET);
  assert.ok(v, 'fresh ticket must verify');
  assert.strictEqual(v.userId, USER_A);
  assert.strictEqual(v.businessId, BIZ_A);
  assert.ok(typeof v.ts === 'number');
  assert.ok(v.nonce.length >= 16);
});

test('ticket: two tickets for the same identity differ (random nonce)', () => {
  const t1 = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const t2 = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  assert.notStrictEqual(t1, t2);
});

test('ticket: expired (ts older than TTL) → null', () => {
  const ts = Date.now() - (STREAM_TICKET_TTL_MS + 1000);
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, ts, secret: SECRET });
  assert.strictEqual(verifyStreamTicket(ticket, SECRET), null);
});

test('ticket: expiry boundary — valid just inside TTL, dead just past it (now override)', () => {
  const ts = Date.now();
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, ts, secret: SECRET });
  assert.ok(verifyStreamTicket(ticket, SECRET, { now: ts + STREAM_TICKET_TTL_MS - 1 }));
  assert.strictEqual(verifyStreamTicket(ticket, SECRET, { now: ts + STREAM_TICKET_TTL_MS + 1 }), null);
});

test('ticket: future-dated beyond skew tolerance → null', () => {
  const now = Date.now();
  const farFuture = signStreamTicket({ userId: USER_A, businessId: BIZ_A, ts: now + 60_000, secret: SECRET });
  assert.strictEqual(verifyStreamTicket(farFuture, SECRET, { now }), null);
  const slightFuture = signStreamTicket({ userId: USER_A, businessId: BIZ_A, ts: now + 2_000, secret: SECRET });
  assert.ok(verifyStreamTicket(slightFuture, SECRET, { now }), 'small clock skew tolerated');
});

test('ticket: tampered payload (businessId swapped, sig kept) → null', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const raw = Buffer.from(ticket, 'base64url').toString('utf8');
  const tamperedRaw = raw.replace(BIZ_A, BIZ_B);
  assert.ok(tamperedRaw !== raw, 'tamper must change the payload');
  const tampered = Buffer.from(tamperedRaw).toString('base64url');
  assert.strictEqual(verifyStreamTicket(tampered, SECRET), null);
});

test('ticket: tampered signature → null', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const raw = Buffer.from(ticket, 'base64url').toString('utf8');
  const parts = raw.split('|');
  const sig = parts[5];
  parts[5] = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  const tampered = Buffer.from(parts.join('|')).toString('base64url');
  assert.strictEqual(verifyStreamTicket(tampered, SECRET), null);
});

test('ticket: signed with a different secret → null', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: OTHER_SECRET });
  assert.strictEqual(verifyStreamTicket(ticket, SECRET), null);
});

test('ticket: garbage / empty / missing inputs → null, never throws', () => {
  assert.strictEqual(verifyStreamTicket('not-a-ticket', SECRET), null);
  assert.strictEqual(verifyStreamTicket('', SECRET), null);
  assert.strictEqual(verifyStreamTicket(null, SECRET), null);
  assert.strictEqual(verifyStreamTicket(Buffer.from('a|b|c').toString('base64url'), SECRET), null);
  const valid = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  assert.strictEqual(verifyStreamTicket(valid, ''), null);
});

test('ticket: sign rejects non-UUID identity and missing secret', () => {
  assert.throws(() => signStreamTicket({ userId: 'admin', businessId: BIZ_A, secret: SECRET }));
  assert.throws(() => signStreamTicket({ userId: USER_A, businessId: 'all', secret: SECRET }));
  assert.throws(() => signStreamTicket({ userId: USER_A, businessId: BIZ_A }));
});

// ─── Domain separation from oauthState (may share N8N_WEBHOOK_SECRET) ──────

test('ticket: an OAuth state signed with the same secret is NOT a valid stream ticket', () => {
  const state = signOAuthState({ businessId: BIZ_A, platform: 'twitter', userId: USER_A, secret: SECRET });
  assert.strictEqual(verifyStreamTicket(state, SECRET), null);
});

test('ticket: a stream ticket is NOT a valid OAuth state', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  assert.strictEqual(verifyOAuthState(ticket, SECRET, { platform: 'twitter' }), null);
});

// ─── Middleware ?ticket= branch ─────────────────────────────────────────────

function runMiddleware(req) {
  const res = makeRes();
  let nextCalled = false;
  requireAuthOrWebhookSecret(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled, req };
}

test('middleware: valid ticket + matching business_id on GET dashboard-events → next, user + authSource set', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { res, nextCalled, req } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/dashboard-events?business_id=${BIZ_A}&ticket=${ticket}`,
      query: { business_id: BIZ_A, ticket },
    })
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(req.user.id, USER_A);
  assert.strictEqual(req.authSource, 'stream-ticket');
  assert.strictEqual(req.streamTicket.businessId, BIZ_A);
});

test('middleware: valid ticket on GET wf15-stream/:id → next', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { nextCalled, req } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/wf15-stream/${MSG_ID}?business_id=${BIZ_A}&ticket=${ticket}`,
      query: { business_id: BIZ_A, ticket },
    })
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.authSource, 'stream-ticket');
});

test('middleware: ticket bound to business A used with business_id B → 403 mismatch', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { res, nextCalled } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/dashboard-events?business_id=${BIZ_B}&ticket=${ticket}`,
      query: { business_id: BIZ_B, ticket },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error.code, 'STREAM_TICKET_BUSINESS_MISMATCH');
});

test('middleware: ticket without business_id query → 403 (binding must be explicit)', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { res, nextCalled } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/dashboard-events?ticket=${ticket}`,
      query: { ticket },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('middleware: expired ticket → 401 INVALID_STREAM_TICKET (hard fail, no fall-through)', () => {
  const ticket = signStreamTicket({
    userId: USER_A,
    businessId: BIZ_A,
    ts: Date.now() - (STREAM_TICKET_TTL_MS + 1000),
    secret: SECRET,
  });
  const { res, nextCalled } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/dashboard-events?business_id=${BIZ_A}&ticket=${ticket}`,
      query: { business_id: BIZ_A, ticket },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error.code, 'INVALID_STREAM_TICKET');
});

test('middleware: tampered ticket → 401', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const raw = Buffer.from(ticket, 'base64url').toString('utf8');
  const tampered = Buffer.from(raw.replace(USER_A, USER_B)).toString('base64url');
  const { res, nextCalled } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/dashboard-events?business_id=${BIZ_A}&ticket=${tampered}`,
      query: { business_id: BIZ_A, ticket: tampered },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
});

test('middleware: ticket on POST → ignored, request falls through to 401', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { res, nextCalled } = runMiddleware(
    makeReq({
      method: 'POST',
      originalUrl: `/webhook/dashboard-events?business_id=${BIZ_A}&ticket=${ticket}`,
      query: { business_id: BIZ_A, ticket },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
});

test('middleware: ticket on a non-allowlisted webhook route → ignored → 401', () => {
  const ticket = signStreamTicket({ userId: USER_A, businessId: BIZ_A, secret: SECRET });
  const { res, nextCalled } = runMiddleware(
    makeReq({
      originalUrl: `/webhook/instant-content?business_id=${BIZ_A}&ticket=${ticket}`,
      query: { business_id: BIZ_A, ticket },
    })
  );
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error.code, 'UNAUTHORIZED');
});

test('middleware: webhook-secret machine path still works alongside ticket branch', () => {
  const { nextCalled, req } = runMiddleware(
    makeReq({
      originalUrl: '/webhook/dashboard-events?business_id=' + BIZ_A,
      query: { business_id: BIZ_A },
      headers: { 'x-webhook-secret': 'test-webhook-secret-0123456789' },
    })
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(req.authSource, 'webhook');
});

// ─── POST /api/stream-ticket mint route ─────────────────────────────────────

function makeMintApp({ owner = USER_A, relationships = [] } = {}) {
  let handler;
  const app = {
    post(path, ...handlers) {
      if (path === '/api/stream-ticket') handler = handlers[handlers.length - 1];
    },
  };
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: BIZ_A, user_id: owner }];
    if (table === 'client_relationships') return relationships;
    if (table === 'workspace_members') return [];
    return [];
  };
  require('../routes/stream-ticket').register({
    app,
    sbGet,
    apiError,
    logger: null,
    env: { N8N_WEBHOOK_SECRET: SECRET },
  });
  return handler;
}

test('mint: owner gets a ticket that verifies back to their identity, expires_in 60', async () => {
  const handler = makeMintApp();
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: BIZ_A } });
  req.user = { id: USER_A };
  const res = makeRes();
  await handler(req, res);
  assert.ok(res.body?.ticket, 'response carries a ticket');
  assert.strictEqual(res.body.expires_in, 60);
  const v = verifyStreamTicket(res.body.ticket, SECRET);
  assert.ok(v);
  assert.strictEqual(v.userId, USER_A);
  assert.strictEqual(v.businessId, BIZ_A);
});

test('mint: non-owner (no workspace access) → 403, no ticket', async () => {
  const handler = makeMintApp({ owner: USER_B });
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: BIZ_A } });
  req.user = { id: USER_A };
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 403);
  assert.ok(!res.body?.ticket);
});

test('mint: invalid business_id → 400', async () => {
  const handler = makeMintApp();
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: 'not-a-uuid' } });
  req.user = { id: USER_A };
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
});

test('mint: missing req.user → 401 (belt-and-braces under the server.js JWT mount)', async () => {
  const handler = makeMintApp();
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: BIZ_A } });
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 401);
});

test('mint: no signing secret configured → 503', async () => {
  let handler;
  const app = {
    post(path, ...handlers) {
      handler = handlers[handlers.length - 1];
    },
  };
  require('../routes/stream-ticket').register({
    app,
    sbGet: async () => [{ id: BIZ_A, user_id: USER_A }],
    apiError,
    logger: null,
    env: {},
  });
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: BIZ_A } });
  req.user = { id: USER_A };
  const res = makeRes();
  await handler(req, res);
  assert.strictEqual(res.statusCode, 503);
});

test('mint: STREAM_TICKET_SECRET env takes precedence over N8N_WEBHOOK_SECRET', async () => {
  let handler;
  const app = {
    post(path, ...handlers) {
      handler = handlers[handlers.length - 1];
    },
  };
  require('../routes/stream-ticket').register({
    app,
    sbGet: async () => [{ id: BIZ_A, user_id: USER_A }],
    apiError,
    logger: null,
    env: { STREAM_TICKET_SECRET: OTHER_SECRET, N8N_WEBHOOK_SECRET: SECRET },
  });
  const req = makeReq({ method: 'POST', originalUrl: '/api/stream-ticket', body: { business_id: BIZ_A } });
  req.user = { id: USER_A };
  const res = makeRes();
  await handler(req, res);
  assert.ok(verifyStreamTicket(res.body.ticket, OTHER_SECRET), 'verifies under dedicated secret');
  assert.strictEqual(verifyStreamTicket(res.body.ticket, SECRET), null, 'not under the fallback');
});
