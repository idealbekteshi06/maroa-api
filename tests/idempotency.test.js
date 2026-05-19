'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeIdempotency } = require('../middleware/idempotency');

function fakeSb() {
  const rows = new Map();
  return {
    sbGet: async (table, query) => {
      if (table !== 'idempotency_keys') return [];
      const m = query.match(/key=eq\.([^&]+)/);
      if (!m) return [];
      const k = decodeURIComponent(m[1]);
      const row = rows.get(k);
      return row ? [row] : [];
    },
    sbPost: async (table, data) => {
      if (table !== 'idempotency_keys') return;
      if (rows.has(data.key)) {
        const e = new Error('duplicate key value violates unique constraint');
        throw e;
      }
      rows.set(data.key, { ...data });
    },
    sbPatch: async (_table, query, patch) => {
      const m = query.match(/key=eq\.([^&]+)/);
      if (!m) return;
      const k = decodeURIComponent(m[1]);
      const row = rows.get(k);
      if (row) Object.assign(row, patch);
    },
    _rows: rows,
  };
}

function makeFakeRes() {
  return {
    statusCode: 200,
    _json: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this._json = b;
      return this;
    },
  };
}

test('passes through GET requests untouched', async () => {
  const { required } = makeIdempotency({ ...fakeSb() });
  let called = false;
  await required({ method: 'GET', headers: {}, path: '/api/x', body: {} }, makeFakeRes(), () => {
    called = true;
  });
  assert.equal(called, true);
});

test('required: returns 400 when key missing', async () => {
  const { required } = makeIdempotency({ ...fakeSb() });
  const res = makeFakeRes();
  await required(
    { method: 'POST', headers: {}, path: '/api/content/publish', body: { x: 1 } },
    res,
    () => {
      throw new Error('next should not be called');
    }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res._json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('required: rejects malformed key', async () => {
  const { required } = makeIdempotency({ ...fakeSb() });
  const res = makeFakeRes();
  await required(
    {
      method: 'POST',
      headers: { 'idempotency-key': 'has spaces!' },
      path: '/api/content/publish',
      body: {},
    },
    res,
    () => {}
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res._json.error.code, 'IDEMPOTENCY_KEY_INVALID');
});

test('first request runs handler, retry returns cached response', async () => {
  const { required } = makeIdempotency({ ...fakeSb() });
  // First call
  const req1 = {
    method: 'POST',
    headers: { 'idempotency-key': 'key-12345' },
    path: '/api/content/publish',
    body: { msg: 'hello' },
  };
  const res1 = makeFakeRes();
  let nextCalled = false;
  await required(req1, res1, () => {
    nextCalled = true;
    res1.status(201).json({ id: 'ct-1' });
  });
  assert.equal(nextCalled, true);
  assert.equal(res1.statusCode, 201);
  assert.equal(res1._json.id, 'ct-1');

  // Second call with same key + same body — should return cached.
  const req2 = { ...req1, body: { msg: 'hello' } };
  const res2 = makeFakeRes();
  let nextCalled2 = false;
  await required(req2, res2, () => {
    nextCalled2 = true;
  });
  assert.equal(nextCalled2, false);
  assert.equal(res2.statusCode, 201);
  assert.equal(res2._json.id, 'ct-1');
});

test('same key + different body = 409 conflict', async () => {
  const { required } = makeIdempotency({ ...fakeSb() });
  const req1 = {
    method: 'POST',
    headers: { 'idempotency-key': 'key-67890' },
    path: '/api/content/publish',
    body: { msg: 'first' },
  };
  const res1 = makeFakeRes();
  await required(req1, res1, () => {
    res1.status(200).json({ ok: true });
  });

  const req2 = { ...req1, body: { msg: 'DIFFERENT' } };
  const res2 = makeFakeRes();
  await required(req2, res2, () => {
    throw new Error('handler should not run on conflict');
  });
  assert.equal(res2.statusCode, 409);
  assert.equal(res2._json.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
});

test('optional middleware lets unkeyed requests through', async () => {
  const { optional } = makeIdempotency({ ...fakeSb() });
  let called = false;
  await optional(
    { method: 'POST', headers: {}, path: '/api/legacy', body: {} },
    makeFakeRes(),
    () => {
      called = true;
    }
  );
  assert.equal(called, true);
});
