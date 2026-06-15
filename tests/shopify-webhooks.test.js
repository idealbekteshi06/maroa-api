'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { buildShopifyWebhookHandler } = require('../services/shopify/webhooks');

const SECRET = 'shpss_webhook_test_secret';
const BIZ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP = 'demo.myshopify.com';

function signWebhook(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

function makeReq({ rawBody, headers = {} }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    body: rawBody,
    requestId: 'test-req',
    get: (name) => lower[String(name).toLowerCase()],
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

// Fake deps. sbPost('webhook_events') returns a row ⇒ markProcessed firstTime;
// sbGet('businesses') resolves the owning business.
function makeDeps() {
  const sent = [];
  const deps = {
    sbGet: async (table) => (table === 'businesses' ? [{ id: BIZ, shopify_access_token_enc: 'v1:x' }] : []),
    sbPost: async () => [{ ok: true }],
    sbPatch: async () => true,
    logger: { info() {}, warn() {}, error() {} },
    inngest: { send: async (evt) => sent.push(evt) },
    secret: () => SECRET,
  };
  return { deps, sent };
}

function orderHeaders(webhookId) {
  return {
    'X-Shopify-Topic': 'orders/create',
    'X-Shopify-Shop-Domain': SHOP,
    'X-Shopify-Webhook-Id': webhookId,
  };
}

test('webhooks: valid signature → 200 and enqueues ingest', async () => {
  const { deps, sent } = makeDeps();
  const handler = buildShopifyWebhookHandler(deps);
  const rawBody = Buffer.from(JSON.stringify({ id: 7001, total_price: '10.00' }));
  const headers = { ...orderHeaders(`wh-${Date.now()}-a`), 'X-Shopify-Hmac-Sha256': signWebhook(rawBody, SECRET) };

  const res = makeRes();
  await handler(makeReq({ rawBody, headers }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'maroa/shopify.resource.ingest');
  assert.equal(sent[0].data.businessId, BIZ);
  assert.equal(sent[0].data.topic, 'orders/create');
});

test('webhooks: tampered body → 401 and does NOT enqueue or dedup', async () => {
  const { deps, sent } = makeDeps();
  let posted = 0;
  deps.sbPost = async () => {
    posted += 1;
    return [{}];
  };
  const handler = buildShopifyWebhookHandler(deps);

  const rawBody = Buffer.from(JSON.stringify({ id: 7002 }));
  const sig = signWebhook(rawBody, SECRET);
  const tampered = Buffer.from(JSON.stringify({ id: 9999 })); // body changed after signing
  const headers = { ...orderHeaders(`wh-${Date.now()}-b`), 'X-Shopify-Hmac-Sha256': sig };

  const res = makeRes();
  await handler(makeReq({ rawBody: tampered, headers }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(sent.length, 0);
  assert.equal(posted, 0, 'must reject before the idempotency write');
});

test('webhooks: duplicate delivery (same webhook id) is processed once', async () => {
  const { deps, sent } = makeDeps();
  const handler = buildShopifyWebhookHandler(deps);
  const rawBody = Buffer.from(JSON.stringify({ id: 7003 }));
  const webhookId = `wh-${Date.now()}-dup`;
  const headers = { ...orderHeaders(webhookId), 'X-Shopify-Hmac-Sha256': signWebhook(rawBody, SECRET) };

  const res1 = makeRes();
  await handler(makeReq({ rawBody, headers }), res1);
  const res2 = makeRes();
  await handler(makeReq({ rawBody, headers }), res2);

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.duplicate, true);
  assert.equal(sent.length, 1, 'side effect must fire exactly once for a duplicate delivery');
});

test('webhooks: app/uninstalled enqueues a store purge', async () => {
  const { deps, sent } = makeDeps();
  const handler = buildShopifyWebhookHandler(deps);
  const rawBody = Buffer.from(JSON.stringify({ id: 1, domain: SHOP }));
  const headers = {
    'X-Shopify-Topic': 'app/uninstalled',
    'X-Shopify-Shop-Domain': SHOP,
    'X-Shopify-Webhook-Id': `wh-${Date.now()}-uninstall`,
    'X-Shopify-Hmac-Sha256': signWebhook(rawBody, SECRET),
  };
  const res = makeRes();
  await handler(makeReq({ rawBody, headers }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'maroa/shopify.store.purge');
  assert.equal(sent[0].data.reason, 'app_uninstalled');
});

test('webhooks: missing secret → 503 (configuration error, not a forgery)', async () => {
  const { deps } = makeDeps();
  deps.secret = () => '';
  const handler = buildShopifyWebhookHandler(deps);
  const rawBody = Buffer.from('{"id":1}');
  const res = makeRes();
  await handler(makeReq({ rawBody, headers: orderHeaders('x') }), res);
  assert.equal(res.statusCode, 503);
});
