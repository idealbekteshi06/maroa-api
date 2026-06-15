'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shopifyGraphQL, shopifyMutate, ShopifyGraphQLError, apiVersion } = require('../lib/shopify/client');

const SHOP = 'demo.myshopify.com';
const okApiRequest = async () => ({ status: 200, body: { data: { ok: true } } });

test('client: API version defaults to the pinned 2026-01', () => {
  const saved = process.env.SHOPIFY_API_VERSION;
  delete process.env.SHOPIFY_API_VERSION;
  try {
    assert.equal(apiVersion(), '2026-01');
  } finally {
    if (saved !== undefined) process.env.SHOPIFY_API_VERSION = saved;
  }
});

test('client: shopifyMutate is a no-op dry-run when SHOPIFY_SYNC_LIVE is off', async () => {
  const saved = process.env.SHOPIFY_SYNC_LIVE;
  delete process.env.SHOPIFY_SYNC_LIVE;
  try {
    let called = false;
    const apiRequest = async () => {
      called = true;
      return { status: 200, body: { data: {} } };
    };
    const result = await shopifyMutate(apiRequest, {
      shop: SHOP,
      accessToken: 'tok',
      query: 'mutation { productUpdate { product { id } } }',
    });
    assert.deepEqual(result, { dryRun: true, skipped: true });
    assert.equal(called, false, 'must not call Shopify when the live flag is off');
  } finally {
    if (saved !== undefined) process.env.SHOPIFY_SYNC_LIVE = saved;
  }
});

test('client: shopifyMutate calls through when SHOPIFY_SYNC_LIVE=true', async () => {
  const saved = process.env.SHOPIFY_SYNC_LIVE;
  process.env.SHOPIFY_SYNC_LIVE = 'true';
  try {
    const result = await shopifyMutate(okApiRequest, { shop: SHOP, accessToken: 'tok', query: 'mutation { x }' });
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.data, { ok: true });
  } finally {
    if (saved === undefined) delete process.env.SHOPIFY_SYNC_LIVE;
    else process.env.SHOPIFY_SYNC_LIVE = saved;
  }
});

test('client: shopifyGraphQL returns the data object on success', async () => {
  const data = await shopifyGraphQL(okApiRequest, { shop: SHOP, accessToken: 'tok', query: '{ shop { name } }' });
  assert.deepEqual(data, { ok: true });
});

test('client: shopifyGraphQL rejects an invalid shop domain (SSRF guard)', async () => {
  await assert.rejects(
    () => shopifyGraphQL(okApiRequest, { shop: 'evil.com', accessToken: 'tok', query: '{ shop { name } }' }),
    ShopifyGraphQLError
  );
});

test('client: shopifyGraphQL surfaces GraphQL-level errors', async () => {
  const apiRequest = async () => ({ status: 200, body: { errors: [{ message: 'Field does not exist' }] } });
  await assert.rejects(
    () => shopifyGraphQL(apiRequest, { shop: SHOP, accessToken: 'tok', query: '{ nope }' }),
    /graphql errors/
  );
});

test('client: shopifyGraphQL throws on an auth failure (401/403)', async () => {
  const apiRequest = async () => ({ status: 401, body: { errors: [{ message: 'unauthorized' }] } });
  await assert.rejects(
    () => shopifyGraphQL(apiRequest, { shop: SHOP, accessToken: 'bad', query: '{ shop { name } }' }),
    ShopifyGraphQLError
  );
});
