'use strict';

/**
 * tests/routes-waitlist.test.js
 *
 * Verifies routes/waitlist.js — uses fake app + fake supabase to test
 * the actual handler logic without a network stack.
 */

const test = require('node:test');
const assert = require('node:assert');

const waitlist = require('../routes/waitlist');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

function makeFakeApp() {
  const routes = {};
  return {
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers[handlers.length - 1];
      routes[`POST ${path}:middlewares`] = handlers.slice(0, -1);
    },
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    _routes: routes,
  };
}

function makeRes() {
  const calls = { status: null, json: null };
  return {
    status(c) {
      calls.status = c;
      return this;
    },
    json(b) {
      calls.json = b;
      return calls;
    },
    _calls: calls,
  };
}

function makeValidate(passthrough) {
  // validate(schemaName) returns Express middleware that puts the body
  // on req.validatedBody.
  return (_schemaName) => (req, _res, next) => {
    req.validatedBody = passthrough ? passthrough(req.body) : req.body;
    next?.();
  };
}

async function dispatch(handler, req, res) {
  // Express handlers don't return — they call res.json/status. Await it.
  await handler(req, res);
  return res._calls;
}

test('routes/waitlist: registers two endpoints', () => {
  const app = makeFakeApp();
  waitlist.register({
    app,
    validate: makeValidate(),
    sbGet: async () => [],
    sbPost: async () => ({}),
    sendEmail: async () => ({ sent: true }),
    apiError: () => {},
    safePublicError: (e) => e.message,
  });
  assert.ok(app._routes['POST /api/waitlist/register']);
  assert.ok(app._routes['GET /api/waitlist/count']);
});

test('routes/waitlist: register inserts into waitlist + emails user + admin', async () => {
  const db = createFakeSupabase();
  const emailsSent = [];
  const app = makeFakeApp();
  waitlist.register({
    app,
    validate: makeValidate(),
    sbGet: db.sbGet,
    sbPost: db.sbPost,
    sendEmail: async (to, subject, html) => {
      emailsSent.push({ to, subject, html });
      return { sent: true };
    },
    apiError: (res, status, code, msg) => res.status(status).json({ error: { code, message: msg } }),
    safePublicError: (e) => e.message,
  });

  const handler = app._routes['POST /api/waitlist/register'];
  const req = {
    body: { name: 'Test User', email: 'test@example.com', plan: 'growth', business_type: 'cafe', country: 'US' },
    validatedBody: {
      name: 'Test User',
      email: 'test@example.com',
      plan: 'growth',
      business_type: 'cafe',
      country: 'US',
    },
  };
  const res = makeRes();
  await handler(req, res);
  // Give fire-and-forget emails a tick to register
  await new Promise((r) => setImmediate(r));

  assert.deepStrictEqual(res._calls.json, { success: true, message: 'Welcome to the waitlist!' });
  const inserted = db.all('waitlist');
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].email, 'test@example.com');
  assert.strictEqual(inserted[0].plan, 'growth');

  // Both emails should have fired
  assert.strictEqual(emailsSent.length, 2);
  assert.strictEqual(emailsSent[0].to, 'test@example.com');
  assert.ok(emailsSent[0].subject.includes('waitlist'));
  assert.strictEqual(emailsSent[1].to, 'idealbekteshi06@gmail.com');
});

test('routes/waitlist: register returns 409 on duplicate email', async () => {
  const app = makeFakeApp();
  const sbPost = async () => {
    throw new Error('duplicate key value violates unique constraint (23505)');
  };
  waitlist.register({
    app,
    validate: makeValidate(),
    sbGet: async () => [],
    sbPost,
    sendEmail: async () => ({ sent: true }),
    apiError: (res, status, code, msg) => res.status(status).json({ error: { code, message: msg } }),
    safePublicError: (e) => e.message,
  });

  const handler = app._routes['POST /api/waitlist/register'];
  const req = { body: {}, validatedBody: { name: 'Dup', email: 'dup@example.com' } };
  const res = makeRes();
  await handler(req, res);

  assert.strictEqual(res._calls.status, 409);
  assert.strictEqual(res._calls.json.error.code, 'CONFLICT');
});

test('routes/waitlist: count returns 0 when DB throws', async () => {
  const app = makeFakeApp();
  waitlist.register({
    app,
    validate: makeValidate(),
    sbGet: async () => {
      throw new Error('db down');
    },
    sbPost: async () => ({}),
    sendEmail: async () => ({ sent: true }),
    apiError: () => {},
    safePublicError: (e) => e.message,
  });

  const handler = app._routes['GET /api/waitlist/count'];
  const req = {};
  const res = makeRes();
  await handler(req, res);
  assert.deepStrictEqual(res._calls.json, { count: 0 });
});

test('routes/waitlist: count returns row count on success', async () => {
  const db = createFakeSupabase();
  db.seed('waitlist', [
    { id: 'a', email: 'a@x.com' },
    { id: 'b', email: 'b@x.com' },
    { id: 'c', email: 'c@x.com' },
  ]);
  const app = makeFakeApp();
  waitlist.register({
    app,
    validate: makeValidate(),
    sbGet: db.sbGet,
    sbPost: db.sbPost,
    sendEmail: async () => ({ sent: true }),
    apiError: () => {},
    safePublicError: (e) => e.message,
  });

  const handler = app._routes['GET /api/waitlist/count'];
  const res = makeRes();
  await handler({}, res);
  assert.strictEqual(res._calls.json.count, 3);
});
