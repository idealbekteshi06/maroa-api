'use strict';

// Encryption must be enabled for the happy-path token store. node --test runs
// each file in its own process, so this key + oauthCrypto's cache are isolated.
process.env.OAUTH_TOKEN_ENC_KEY = 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildShopifyOAuthHandlers } = require('../services/shopify/oauth');
const { signOAuthState } = require('../lib/oauthState');

const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHOP = 'demo.myshopify.com';

const CONFIG = {
  API_KEY: 'apikey123',
  API_SECRET: 'apisecret456',
  REDIRECT_URI: 'https://api.test/auth/shopify/callback',
  FRONTEND_URL: 'https://front.test',
  STATE_SECRET: 'state-secret-at-least-16-chars',
  SCOPES: 'read_orders,read_products,write_products,read_customers',
};

const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const noopLogger = { info() {}, warn() {}, error() {} };

function makeReq({ query = {}, headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { query, get: (name) => lower[String(name).toLowerCase()] };
}
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    redirectUrl: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirectUrl = url;
      return this;
    },
  };
}

function signQuery(params, secret) {
  const message = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// ─── install ─────────────────────────────────────────────────────────────────

function installDeps(overrides = {}) {
  return buildShopifyOAuthHandlers({
    sbGet: async (table, q) => (/user_id=eq\./.test(q) && /id=eq\./.test(q) ? [{ id: BIZ }] : []),
    sbPatch: async () => true,
    sbPost: async () => ({}),
    apiError,
    logger: noopLogger,
    verifyUserJwt: async (t) => (t === 'goodjwt' ? { id: USER } : null),
    inngest: { send: async () => {} },
    config: CONFIG,
    ...overrides,
  });
}

test('oauth install: valid owner → 302 to Shopify consent with state + scopes', async () => {
  const { install } = installDeps();
  const res = makeRes();
  await install(makeReq({ query: { shop: SHOP, businessId: BIZ }, headers: { authorization: 'Bearer goodjwt' } }), res);
  assert.equal(res.statusCode, 302);
  assert.ok(res.redirectUrl.startsWith(`https://${SHOP}/admin/oauth/authorize?`));
  assert.match(res.redirectUrl, /client_id=apikey123/);
  assert.match(res.redirectUrl, /state=/);
  assert.match(res.redirectUrl, /scope=read_orders/);
});

test('oauth install: rejects spoofed shop domain', async () => {
  const { install } = installDeps();
  const res = makeRes();
  await install(
    makeReq({ query: { shop: 'evil.com', businessId: BIZ }, headers: { authorization: 'Bearer goodjwt' } }),
    res
  );
  assert.equal(res.statusCode, 400);
});

test('oauth install: rejects missing JWT', async () => {
  const { install } = installDeps();
  const res = makeRes();
  await install(makeReq({ query: { shop: SHOP, businessId: BIZ } }), res);
  assert.equal(res.statusCode, 401);
});

test('oauth install: rejects a user who does not own the business (IDOR)', async () => {
  const { install } = installDeps({ sbGet: async () => [] });
  const res = makeRes();
  await install(makeReq({ query: { shop: SHOP, businessId: BIZ }, headers: { authorization: 'Bearer goodjwt' } }), res);
  assert.equal(res.statusCode, 403);
});

// ─── callback ──────────────────────────────────────────────────────────────

function callbackDeps(overrides = {}) {
  const captured = { patch: null, sent: [] };
  const handlers = buildShopifyOAuthHandlers({
    sbGet: async () => [],
    sbPatch: async (table, filter, data) => {
      captured.patch = { table, filter, data };
      return true;
    },
    sbPost: async () => ({}),
    apiError,
    logger: noopLogger,
    verifyUserJwt: async () => null,
    inngest: { send: async (evt) => captured.sent.push(evt) },
    config: CONFIG,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'shpat_secret_token', scope: 'read_orders,read_products' }),
    }),
    ...overrides,
  });
  return { handlers, captured };
}

test('oauth callback: valid HMAC + state stores ENCRYPTED token and enqueues sync', async () => {
  const { handlers, captured } = callbackDeps();
  const state = signOAuthState({ businessId: BIZ, platform: 'shopify', userId: USER, secret: CONFIG.STATE_SECRET });
  const query = { shop: SHOP, code: 'thecode', state, timestamp: '1700000000' };
  query.hmac = signQuery(query, CONFIG.API_SECRET);

  const res = makeRes();
  await handlers.callback(makeReq({ query }), res);

  assert.equal(res.statusCode, 302);
  assert.match(res.redirectUrl, /shopify=connected/);
  assert.equal(captured.patch.table, 'businesses');
  assert.equal(captured.patch.filter, `id=eq.${BIZ}`);
  assert.match(captured.patch.data.shopify_access_token_enc, /^v1:/); // encrypted, not plaintext
  assert.equal(captured.patch.data.shopify_access_token, undefined); // no plaintext twin
  assert.equal(captured.patch.data.shopify_shop_domain, SHOP);
  assert.equal(captured.patch.data.shopify_connected, true);
  assert.equal(captured.sent.length, 1);
  assert.equal(captured.sent[0].name, 'maroa/shopify.install.sync');
  assert.equal(captured.sent[0].data.businessId, BIZ);
});

test('oauth callback: rejects an invalid Shopify HMAC (no token stored)', async () => {
  const { handlers, captured } = callbackDeps();
  const state = signOAuthState({ businessId: BIZ, platform: 'shopify', userId: USER, secret: CONFIG.STATE_SECRET });
  const query = { shop: SHOP, code: 'thecode', state, timestamp: '1700000000', hmac: 'deadbeef' };

  const res = makeRes();
  await handlers.callback(makeReq({ query }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_HMAC');
  assert.equal(captured.patch, null);
  assert.equal(captured.sent.length, 0);
});

test('oauth callback: rejects a bad/forged state even with a valid HMAC', async () => {
  const { handlers, captured } = callbackDeps();
  const query = { shop: SHOP, code: 'thecode', state: 'not-a-real-state', timestamp: '1700000000' };
  query.hmac = signQuery(query, CONFIG.API_SECRET); // HMAC is valid for THESE params

  const res = makeRes();
  await handlers.callback(makeReq({ query }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_STATE');
  assert.equal(captured.patch, null);
});

test('oauth callback: rejects a state minted for another platform (no cross-provider replay)', async () => {
  const { handlers } = callbackDeps();
  const state = signOAuthState({ businessId: BIZ, platform: 'tiktok', userId: USER, secret: CONFIG.STATE_SECRET });
  const query = { shop: SHOP, code: 'thecode', state, timestamp: '1700000000' };
  query.hmac = signQuery(query, CONFIG.API_SECRET);

  const res = makeRes();
  await handlers.callback(makeReq({ query }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'INVALID_STATE');
});
