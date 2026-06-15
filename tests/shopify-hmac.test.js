'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyWebhookHmac, verifyQueryHmac, isValidShopDomain } = require('../lib/shopify/hmac');

const SECRET = 'shpss_test_secret_value';

// ─── Webhook HMAC (base64 over raw body) ─────────────────────────────────────

function signWebhook(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

test('shopify-hmac: verifyWebhookHmac accepts a valid signature', () => {
  const body = Buffer.from(JSON.stringify({ id: 1234, total_price: '19.99' }));
  const sig = signWebhook(body, SECRET);
  assert.equal(verifyWebhookHmac(body, sig, SECRET), true);
});

test('shopify-hmac: verifyWebhookHmac accepts a string body too', () => {
  const body = JSON.stringify({ id: 1 });
  const sig = signWebhook(Buffer.from(body), SECRET);
  assert.equal(verifyWebhookHmac(body, sig, SECRET), true);
});

test('shopify-hmac: verifyWebhookHmac rejects a tampered body', () => {
  const body = Buffer.from(JSON.stringify({ id: 1234 }));
  const sig = signWebhook(body, SECRET);
  const tampered = Buffer.from(JSON.stringify({ id: 9999 }));
  assert.equal(verifyWebhookHmac(tampered, sig, SECRET), false);
});

test('shopify-hmac: verifyWebhookHmac rejects a wrong secret', () => {
  const body = Buffer.from('{"id":1}');
  const sig = signWebhook(body, SECRET);
  assert.equal(verifyWebhookHmac(body, sig, 'other-secret'), false);
});

test('shopify-hmac: verifyWebhookHmac rejects missing/garbage signature', () => {
  const body = Buffer.from('{"id":1}');
  assert.equal(verifyWebhookHmac(body, '', SECRET), false);
  assert.equal(verifyWebhookHmac(body, 'not-real-base64!!!', SECRET), false);
  assert.equal(verifyWebhookHmac(null, signWebhook(body, SECRET), SECRET), false);
});

// ─── OAuth query HMAC (hex over sorted params) ───────────────────────────────

function signQuery(params, secret) {
  const message = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

test('shopify-hmac: verifyQueryHmac accepts a valid OAuth redirect', () => {
  const params = { code: 'abc', shop: 'demo.myshopify.com', state: 'st8', timestamp: '1700000000' };
  params.hmac = signQuery(params, SECRET);
  assert.equal(verifyQueryHmac(params, SECRET), true);
});

test('shopify-hmac: verifyQueryHmac rejects a tampered param', () => {
  const params = { code: 'abc', shop: 'demo.myshopify.com', state: 'st8', timestamp: '1700000000' };
  params.hmac = signQuery(params, SECRET);
  params.shop = 'attacker.myshopify.com'; // change after signing
  assert.equal(verifyQueryHmac(params, SECRET), false);
});

test('shopify-hmac: verifyQueryHmac rejects when hmac is missing or secret wrong', () => {
  const params = { code: 'abc', shop: 'demo.myshopify.com' };
  assert.equal(verifyQueryHmac(params, SECRET), false);
  params.hmac = signQuery(params, SECRET);
  assert.equal(verifyQueryHmac(params, 'wrong'), false);
});

// ─── Shop domain validation (SSRF / open-redirect guard) ─────────────────────

test('shopify-hmac: isValidShopDomain accepts real myshopify domains', () => {
  assert.equal(isValidShopDomain('examplestore.myshopify.com'), true);
  assert.equal(isValidShopDomain('Example-Store.myshopify.com'), true);
});

test('shopify-hmac: isValidShopDomain rejects spoofed / malformed domains', () => {
  assert.equal(isValidShopDomain('evil.com'), false);
  assert.equal(isValidShopDomain('shop.myshopify.com.evil.com'), false);
  assert.equal(isValidShopDomain('foo_bar.myshopify.com'), false);
  assert.equal(isValidShopDomain('https://demo.myshopify.com'), false);
  assert.equal(isValidShopDomain(''), false);
  assert.equal(isValidShopDomain(null), false);
});
