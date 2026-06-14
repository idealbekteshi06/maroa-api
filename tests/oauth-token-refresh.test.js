'use strict';

// Smoke tests for the proactive OAuth token-refresh service (feature #2).
// node:test runs each file in its own process, so setting env here is isolated.

process.env.OAUTH_TOKEN_ENC_KEY = '0'.repeat(64); // 32 bytes hex → encryption ON
process.env.LINKEDIN_CLIENT_ID = 'li_id';
process.env.LINKEDIN_CLIENT_SECRET = 'li_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const tr = require('../services/oauth/tokenRefresh');

function biz(extra = {}) {
  return { id: 'b1', linkedin_connected: true, linkedin_refresh_token: 'r0', ...extra };
}

test('isDue: unknown expiry (NULL) → due', () => {
  assert.equal(tr.isDue(biz({ linkedin_token_expires_at: null }), 'linkedin'), true);
});

test('isDue: far-future expiry → not due', () => {
  const far = new Date(Date.now() + 100 * 3600 * 1000).toISOString();
  assert.equal(tr.isDue(biz({ linkedin_token_expires_at: far }), 'linkedin', 120), false);
});

test('isDue: within lead window → due', () => {
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  assert.equal(tr.isDue(biz({ linkedin_token_expires_at: soon }), 'linkedin', 120), true);
});

test('isDue: not connected → not due', () => {
  assert.equal(tr.isDue(biz({ linkedin_connected: false }), 'linkedin'), false);
});

test('isDue: no refresh token → not due', () => {
  assert.equal(tr.isDue({ id: 'b', linkedin_connected: true }, 'linkedin'), false);
});

test('refreshOne: hits the provider and persists new access + rotated refresh + expiry', async () => {
  let patched = null;
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://www.linkedin.com/oauth/v2/accessToken');
    assert.match(opts.body, /grant_type=refresh_token/);
    assert.match(opts.body, /refresh_token=r0/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'newA', refresh_token: 'newR', expires_in: 3600 }),
    };
  };
  const r = await tr.refreshOne({
    business: biz(),
    provider: 'linkedin',
    deps: {
      sbPatch: async (table, filter, patch) => {
        patched = { table, filter, patch };
      },
      logger: {},
      fetchImpl,
    },
  });
  assert.equal(r.ok, true);
  assert.equal(patched.table, 'businesses');
  // encryption enabled → tokens land in *_enc, never plaintext
  assert.ok(patched.patch.linkedin_access_token_enc, 'access token encrypted');
  assert.ok(patched.patch.linkedin_refresh_token_enc, 'rotated refresh token encrypted');
  assert.ok(patched.patch.linkedin_token_expires_at, 'expiry persisted');
  assert.ok(!('linkedin_access_token' in patched.patch), 'no plaintext access token written');
});

test('refreshOne: no refresh token → skipped, no fetch', async () => {
  const r = await tr.refreshOne({
    business: { id: 'b', linkedin_connected: true },
    provider: 'linkedin',
    deps: {
      sbPatch: async () => {
        throw new Error('should not patch');
      },
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_refresh_token');
});

test('refreshOne: provider error → ok:false, no persist, no throw', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
  const r = await tr.refreshOne({
    business: biz(),
    provider: 'linkedin',
    deps: {
      sbPatch: async () => {
        throw new Error('should not patch on error');
      },
      logger: { warn() {} },
      fetchImpl,
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('refreshAllDue: iterates connected businesses and counts outcomes', async () => {
  const businesses = [
    biz({ id: 'due1', linkedin_token_expires_at: null }), // due
    biz({ id: 'notdue', linkedin_token_expires_at: new Date(Date.now() + 99 * 3600 * 1000).toISOString() }),
  ];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
  });
  const out = await tr.refreshAllDue({
    deps: { sbGet: async () => businesses, sbPatch: async () => {}, logger: {}, fetchImpl },
  });
  assert.equal(out.ok, true);
  assert.equal(out.due, 1);
  assert.equal(out.refreshed, 1);
  assert.equal(out.failed, 0);
});
