'use strict';

// Lead/contact capture v1 — routes/lead-capture.js.
// Covers: capture-token sign/verify, hosted-form capture (upsert + activity +
// enrollment + event + WF2 scoring), honeypot, email validation, throttle,
// Meta Lead Ads signature verification, leadgen processing and dedup.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { register, makeCaptureToken, parseCaptureToken, makeThrottle } = require('../routes/lead-capture');

const BIZ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV = { LEAD_CAPTURE_SECRET: 'test-secret', META_APP_SECRET: 'meta-secret' };

// ─── token + throttle primitives ────────────────────────────────────────────

test('capture token: roundtrip + tamper rejection', () => {
  const token = makeCaptureToken(BIZ_ID, ENV);
  assert.ok(token.startsWith(`${BIZ_ID}.`));
  assert.equal(parseCaptureToken(token, ENV), BIZ_ID);
  assert.equal(parseCaptureToken(`${BIZ_ID}.deadbeef`, ENV), null, 'bad sig rejected');
  assert.equal(parseCaptureToken(token.slice(0, -1) + '0', ENV), null, 'tampered sig rejected');
  assert.equal(parseCaptureToken('not-a-token', ENV), null);
  assert.equal(parseCaptureToken(token, {}), null, 'no secret configured → reject');
});

test('throttle: allows within limit, blocks past it, isolates IPs', () => {
  const allow = makeThrottle({ limit: 3, windowMs: 60000 });
  assert.equal(allow('1.1.1.1'), true);
  assert.equal(allow('1.1.1.1'), true);
  assert.equal(allow('1.1.1.1'), true);
  assert.equal(allow('1.1.1.1'), false, '4th hit blocked');
  assert.equal(allow('2.2.2.2'), true, 'other IPs unaffected');
});

// ─── route harness ──────────────────────────────────────────────────────────

function buildHarness({ sequences = [], business, leadFetch } = {}) {
  const handlers = {};
  const writes = { posts: [], patches: [], apiCalls: [] };
  const scored = [];
  const app = {
    post: (path, ...mw) => {
      handlers[`POST ${path}`] = mw;
    },
    get: (path, ...mw) => {
      handlers[`GET ${path}`] = mw;
    },
    options: (path, ...mw) => {
      handlers[`OPTIONS ${path}`] = mw;
    },
  };
  const metaHandlers = register({
    app,
    express: null,
    requireAnyUserId: (req, _res, next) => next(),
    sbGet: async (table, q) => {
      if (table === 'email_sequences') return sequences;
      if (table === 'businesses') {
        if (business && q.includes('facebook_page_id')) return [business];
        if (business && q.includes('user_id=eq.')) return [{ id: business.id }];
        return business ? [business] : [];
      }
      return [];
    },
    sbPost: async (table, row) => {
      writes.posts.push({ table, row });
      return [row];
    },
    sbPatch: async () => true,
    apiRequest: async (method, url, headers, body) => {
      writes.apiCalls.push({ method, url, body });
      if (url.includes('/rest/v1/contacts')) return { status: 201, body: [{ id: 'contact-1' }] };
      if (url.includes('graph.facebook.com')) return leadFetch || { status: 200, body: { field_data: [] } };
      return { status: 200, body: {} };
    },
    sbH: () => ({}),
    SUPABASE_URL: 'https://sb.example',
    oauthCrypto: { readToken: (row) => row?.meta_access_token || null },
    wf2: {
      rescoreLead: async ({ leadId }) => {
        scored.push(leadId);
        return { score: 50, tier: 'warm' };
      },
    },
    markProcessed: async ({ eventId }) => ({
      firstTime: !buildHarness.seen.has(eventId) && !!buildHarness.seen.add(eventId),
    }),
    log: () => {},
    env: ENV,
  });
  return { handlers, writes, scored, metaHandlers };
}
buildHarness.seen = new Set();

function fakeRes() {
  const res = { statusCode: 200, headers: {} };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (x) => {
    res.body = x;
    return res;
  };
  res.send = (x) => {
    res.body = x;
    return res;
  };
  res.set = () => res;
  res.end = () => res;
  return res;
}

async function runRoute(handlers, key, req) {
  const mw = handlers[key];
  assert.ok(mw, `route ${key} registered`);
  const res = fakeRes();
  // run the final handler (parsers are skipped: express=null in harness)
  await mw[mw.length - 1](req, res);
  return res;
}

test('hosted form: valid submit upserts contact, enrolls, events, scores', async () => {
  const h = buildHarness({ sequences: [{ id: 'seq-1' }] });
  const token = makeCaptureToken(BIZ_ID, ENV);
  const res = await runRoute(h.handlers, 'POST /public/lead-capture/:token', {
    params: { token },
    headers: {},
    socket: { remoteAddress: '9.9.9.9' },
    body: { email: 'Lead@Example.com', first_name: 'Ana', phone: '+383' },
  });
  assert.equal(res.body?.ok, true);
  assert.equal(res.body.enrolled, true);

  const upsert = h.writes.apiCalls.find((c) => c.url.includes('/rest/v1/contacts'));
  assert.equal(upsert.body.email, 'lead@example.com', 'email normalized');
  assert.equal(upsert.body.source, 'form');

  const activity = h.writes.posts.find((p) => p.table === 'contact_activities');
  assert.equal(activity.row.activity_type, 'form_fill');
  const enrollment = h.writes.posts.find((p) => p.table === 'contact_enrollments');
  assert.equal(enrollment.row.sequence_id, 'seq-1');
  const evt = h.writes.posts.find((p) => p.table === 'events');
  assert.equal(evt.row.kind, 'lead.captured');
  assert.deepEqual(h.scored, ['contact-1'], 'WF2 scoring fired');
});

test('hosted form: honeypot filled → 200 but nothing stored', async () => {
  const h = buildHarness();
  const token = makeCaptureToken(BIZ_ID, ENV);
  const res = await runRoute(h.handlers, 'POST /public/lead-capture/:token', {
    params: { token },
    headers: {},
    socket: { remoteAddress: '9.9.9.8' },
    body: { email: 'bot@spam.com', website: 'http://spam' },
  });
  assert.equal(res.body?.ok, true, 'bots get a bland 200');
  assert.equal(h.writes.apiCalls.length, 0, 'no contact written');
});

test('hosted form: invalid token → 404, invalid email → 400', async () => {
  const h = buildHarness();
  const bad = await runRoute(h.handlers, 'POST /public/lead-capture/:token', {
    params: { token: `${BIZ_ID}.wrong` },
    headers: {},
    socket: { remoteAddress: '9.9.9.7' },
    body: { email: 'a@b.co' },
  });
  assert.equal(bad.statusCode, 404);

  const token = makeCaptureToken(BIZ_ID, ENV);
  const noEmail = await runRoute(h.handlers, 'POST /public/lead-capture/:token', {
    params: { token },
    headers: {},
    socket: { remoteAddress: '9.9.9.6' },
    body: { email: 'not-an-email' },
  });
  assert.equal(noEmail.statusCode, 400);
});

// ─── Meta Lead Ads intake ───────────────────────────────────────────────────

function signedMetaReq(payload, secret = ENV.META_APP_SECRET) {
  const raw = Buffer.from(JSON.stringify(payload));
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return { headers: { 'x-hub-signature-256': sig }, body: raw };
}

const LEADGEN_PAYLOAD = {
  entry: [
    {
      changes: [{ field: 'leadgen', value: { leadgen_id: 'lg-1', page_id: 'page-77' } }],
    },
  ],
};

test('meta-leads: bad signature → 401, nothing processed', async () => {
  const h = buildHarness({ business: { id: BIZ_ID, meta_access_token: 'tok' } });
  const req = signedMetaReq(LEADGEN_PAYLOAD, 'WRONG-secret');
  const res = fakeRes();
  await h.metaHandlers.metaLeadsIntake(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(h.writes.apiCalls.length, 0);
});

test('meta-leads: signed leadgen → Graph fetch → contact captured; redelivery deduped', async () => {
  buildHarness.seen = new Set(); // reset dedup between tests
  const h = buildHarness({
    business: { id: BIZ_ID, facebook_page_id: 'page-77', meta_access_token: 'tok' },
    leadFetch: {
      status: 200,
      body: {
        field_data: [
          { name: 'email', values: ['fresh@lead.com'] },
          { name: 'full_name', values: ['Fresh Lead'] },
          { name: 'phone_number', values: ['+38344'] },
        ],
      },
    },
  });
  const req = signedMetaReq(LEADGEN_PAYLOAD);
  const res = fakeRes();
  await h.metaHandlers.metaLeadsIntake(req, res);
  assert.equal(res.body?.ok, true, 'acks fast');

  const graphCall = h.writes.apiCalls.find((c) => c.url.includes('graph.facebook.com'));
  assert.ok(graphCall, 'lead details fetched from Graph');
  assert.match(graphCall.url, /lg-1/);

  const upsert = h.writes.apiCalls.find((c) => c.url.includes('/rest/v1/contacts'));
  assert.equal(upsert.body.email, 'fresh@lead.com');
  assert.equal(upsert.body.first_name, 'Fresh');
  assert.equal(upsert.body.last_name, 'Lead');
  assert.equal(upsert.body.source, 'meta_lead_ad');

  // Redelivery of the same leadgen_id must be a no-op.
  const before = h.writes.apiCalls.length;
  const res2 = fakeRes();
  await h.metaHandlers.metaLeadsIntake(signedMetaReq(LEADGEN_PAYLOAD), res2);
  assert.equal(h.writes.apiCalls.length, before, 'duplicate leadgen deduped');
});

test('meta-leads: subscription handshake echoes hub.challenge only with the right token', async () => {
  const h = buildHarness();
  const ok = fakeRes();
  h.metaHandlers.metaLeadsVerify(
    { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test-secret', 'hub.challenge': 'echo-me' } },
    ok
  );
  assert.equal(ok.body, 'echo-me');

  const bad = fakeRes();
  h.metaHandlers.metaLeadsVerify(
    { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'echo-me' } },
    bad
  );
  assert.equal(bad.statusCode, 403);
});
