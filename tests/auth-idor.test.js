'use strict';

/**
 * tests/auth-idor.test.js
 *
 * Regression tests for the 2026-05-13 audit IDOR finding.
 *
 * Previously, /api/* routes accepted any well-formed UUID via the legacy
 * fallback path — any attacker who guessed or leaked a UUID could read
 * /api/metrics, /api/strategy, /api/checkout, etc.
 *
 * After the fix, the middleware:
 *   - Requires Bearer JWT in production (LEGACY_USERID_FALLBACK_ALLOWED off)
 *   - 403 FORBIDDEN_OWNERSHIP when the request's userId disagrees with
 *     the token's user.id
 *   - 401 AUTH_REQUIRED when no Bearer and the legacy flag is off
 *   - Increments auth_idor_blocked_total + auth_legacy_fallback_total
 *
 * These tests exercise the middleware factory directly with stub
 * dependencies — no live Supabase, no HTTP server.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeAuthenticateUserId } = require('../middleware/authenticateUserId');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const BAD_TOKEN_ERROR = { data: null, error: new Error('invalid token') };

function makeReq({ headers = {}, body = {}, params = {}, query = {}, path = '/api/x' } = {}) {
  return {
    headers,
    body,
    params,
    query,
    path,
    get(name) {
      const k = String(name).toLowerCase();
      return headers[k] != null ? headers[k] : headers[name];
    },
  };
}

function makeRes() {
  const res = {
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
  return res;
}

function makeMetrics() {
  const calls = [];
  return {
    calls,
    increment(name, labels) {
      calls.push({ name, labels });
    },
  };
}

function tokenGetter(map) {
  // Returns a fake supabaseAdminGetUser: { token → { data: { user: { id } } } }
  return async (token) => {
    if (map[token]) return { data: { user: { id: map[token] } }, error: null };
    return BAD_TOKEN_ERROR;
  };
}

function apiError(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// ─── Bearer path: ownership match ─────────────────────────────────────────

test('idor: valid Bearer + matching userId in body → next() called, user injected', async () => {
  const metrics = makeMetrics();
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics,
    env: {},
    apiError,
  });
  let called = false;
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { userId: USER_A },
  });
  const res = makeRes();
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
  assert.strictEqual(req.user.id, USER_A);
  assert.strictEqual(metrics.calls.length, 0, 'no metrics should fire on happy path');
});

test('idor: valid Bearer + matching user_id (snake_case) in body → next()', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  let called = false;
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { user_id: USER_A },
  });
  const res = makeRes();
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
});

test('idor: valid Bearer + no userId in body → injects authenticated id', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ headers: { authorization: 'Bearer tok-A' }, body: {} });
  const res = makeRes();
  let called = false;
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
  assert.strictEqual(req.body.userId, USER_A);
  assert.strictEqual(req.body.user_id, USER_A);
  assert.strictEqual(req.params.userId, USER_A);
});

test('idor: valid Bearer + matching userId in params → next()', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    params: { userId: USER_A },
  });
  const res = makeRes();
  let called = false;
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
});

// ─── Bearer path: ownership mismatch (the IDOR fix) ───────────────────────

test('idor: valid Bearer + DIFFERENT userId in body → 403 + auth_idor_blocked_total++', async () => {
  const metrics = makeMetrics();
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics,
    env: {},
    apiError,
  });
  let called = false;
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { userId: USER_B },
    path: '/api/metrics',
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => { called = true; });
    setTimeout(resolve, 20);
  });
  assert.strictEqual(called, false, 'next should NOT be called on IDOR');
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.error, 'FORBIDDEN_OWNERSHIP');
  assert.ok(metrics.calls.some((c) => c.name === 'auth_idor_blocked_total'));
});

test('idor: valid Bearer + DIFFERENT user_id (snake) → 403', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { user_id: USER_B },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 403);
});

test('idor: valid Bearer + DIFFERENT userId in params → 403', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    params: { userId: USER_B },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 403);
});

test('idor: valid Bearer + DIFFERENT userId in query → 403', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    query: { userId: USER_B },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 403);
});

// ─── Bearer path: invalid token ───────────────────────────────────────────

test('idor: invalid Bearer token → 401 UNAUTHORIZED', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ headers: { authorization: 'Bearer bad-token' }, body: { userId: USER_A } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, 'UNAUTHORIZED');
});

test('idor: Supabase throws → 401 (caught, not 500)', async () => {
  const throwingGetter = async () => {
    throw new Error('supabase down');
  };
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: throwingGetter,
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ headers: { authorization: 'Bearer x' }, body: { userId: USER_A } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
});

test('idor: supabaseAdminGetUser missing → 503 AUTH_UNAVAILABLE', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: undefined,
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ headers: { authorization: 'Bearer x' } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.error, 'AUTH_UNAVAILABLE');
});

// ─── Legacy fallback OFF (production default) ─────────────────────────────

test('idor: no Bearer + flag off + valid UUID → 401 AUTH_REQUIRED (THE FIX)', async () => {
  const metrics = makeMetrics();
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics,
    env: {},
    apiError,
  });
  const req = makeReq({ body: { userId: USER_A } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, 'AUTH_REQUIRED');
  assert.strictEqual(metrics.calls.length, 0, 'no legacy-fallback metric when flag is off');
});

test('idor: no Bearer + flag off + missing userId → 401 AUTH_REQUIRED', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ body: {} });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
});

test('idor: no Bearer + flag off + bad UUID → still 401 (fast path)', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({ body: { userId: 'not-a-uuid' } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
});

// ─── Legacy fallback ON (transition window) ───────────────────────────────

test('idor: no Bearer + flag on + valid UUID → next() + legacy metric', async () => {
  const metrics = makeMetrics();
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics,
    env: { LEGACY_USERID_FALLBACK_ALLOWED: '1' },
    apiError,
  });
  const req = makeReq({ body: { userId: USER_A }, path: '/api/metrics' });
  const res = makeRes();
  let called = false;
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
  assert.ok(metrics.calls.some((c) => c.name === 'auth_legacy_fallback_total'));
  assert.ok(metrics.calls[0].labels.route === '/api/metrics');
});

test('idor: no Bearer + flag on + missing userId → 400 VALIDATION_ERROR', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: { LEGACY_USERID_FALLBACK_ALLOWED: '1' },
    apiError,
  });
  const req = makeReq({ body: {} });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 400);
});

test('idor: no Bearer + flag on + bad UUID → 400 VALIDATION_ERROR', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: { LEGACY_USERID_FALLBACK_ALLOWED: '1' },
    apiError,
  });
  const req = makeReq({ body: { userId: 'short' } });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 400);
});

test('idor: flag accepts truthy variants ("1", "true", "yes", "on")', async () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    const mw = makeAuthenticateUserId({
      supabaseAdminGetUser: tokenGetter({}),
      metrics: makeMetrics(),
      env: { LEGACY_USERID_FALLBACK_ALLOWED: v },
      apiError,
    });
    const req = makeReq({ body: { userId: USER_A } });
    const res = makeRes();
    let called = false;
    await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
    assert.strictEqual(called, true, `expected next() with flag="${v}"`);
  }
});

test('idor: flag rejects falsy variants ("0", "false", "", undefined)', async () => {
  for (const v of ['0', 'false', '', undefined, null]) {
    const mw = makeAuthenticateUserId({
      supabaseAdminGetUser: tokenGetter({}),
      metrics: makeMetrics(),
      env: { LEGACY_USERID_FALLBACK_ALLOWED: v },
      apiError,
    });
    const req = makeReq({ body: { userId: USER_A } });
    const res = makeRes();
    await new Promise((resolve) => {
      mw(req, res, () => {});
      setTimeout(resolve, 20);
    });
    assert.strictEqual(res.statusCode, 401, `expected 401 with flag="${v}"`);
  }
});

// ─── Edge cases ───────────────────────────────────────────────────────────

test('idor: malformed Authorization header (not Bearer) falls through to legacy path', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({}),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Basic abc:def' },
    body: { userId: USER_A },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.error, 'AUTH_REQUIRED');
});

test('idor: case-insensitive Bearer parsing', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'bearer tok-A' }, // lowercase
    body: { userId: USER_A },
  });
  const res = makeRes();
  let called = false;
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.strictEqual(called, true);
});

test('idor: metrics never thrown even if metrics module misbehaves', async () => {
  const badMetrics = {
    increment() {
      throw new Error('metrics down');
    },
  };
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: badMetrics,
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { userId: USER_B },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 403, 'IDOR still blocks even if metrics throw');
});

test('idor: metrics labels include route path for blast-radius visibility', async () => {
  const metrics = makeMetrics();
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics,
    env: {},
    apiError,
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { userId: USER_B },
    path: '/api/strategy',
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.ok(
    metrics.calls.some(
      (c) => c.name === 'auth_idor_blocked_total' && c.labels && c.labels.route === '/api/strategy'
    )
  );
});

test('idor: apiError defaults work when not injected', async () => {
  const mw = makeAuthenticateUserId({
    supabaseAdminGetUser: tokenGetter({ 'tok-A': USER_A }),
    metrics: makeMetrics(),
    env: {},
    // no apiError — should use default
  });
  const req = makeReq({
    headers: { authorization: 'Bearer tok-A' },
    body: { userId: USER_B },
  });
  const res = makeRes();
  await new Promise((resolve) => {
    mw(req, res, () => {});
    setTimeout(resolve, 20);
  });
  assert.strictEqual(res.statusCode, 403);
  assert.ok(res.body.error);
});
