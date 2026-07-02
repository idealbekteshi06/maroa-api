'use strict';

/**
 * tests/shopify.test.js — store catalog ingestion (migration 096)
 * Run: node --test tests/shopify.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createShopifyService, normalizeStoreUrl } = require('../services/shopify');
const shopifyRoutes = require('../routes/shopify');

const BIZ = 'fea4aae5-14b4-486d-89f4-33a7d7e4ab60';
const OWNER = '11111111-2222-3333-4444-555555555555';
const STRANGER = '99999999-8888-7777-6666-555555555555';

// ─── fixtures ────────────────────────────────────────────────────────────────

const CANNED_PRODUCTS_JSON = {
  products: [
    {
      id: 123456789,
      title: 'Insulated Water Bottle',
      handle: 'insulated-water-bottle',
      body_html: '<p>Keeps drinks <b>cold</b> for 24h.</p><script>evil()</script>' + 'x'.repeat(3000),
      vendor: 'HydroCo',
      tags: 'hydration, outdoors, bestseller',
      variants: [{ price: '29.99', presentment_prices: [{ price: { currency_code: 'EUR' } }] }],
      images: Array.from({ length: 12 }, (_, i) => ({ src: `https://cdn.shopify.com/img-${i}.jpg` })),
    },
    {
      id: 987654321,
      title: 'Bottle Brush',
      handle: 'bottle-brush',
      body_html: '<p>Cleans deep.</p>',
      vendor: 'HydroCo',
      tags: ['cleaning'],
      variants: [{ price: '9.50' }],
      images: [{ src: 'https://cdn.shopify.com/brush.jpg' }],
    },
  ],
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body); // throws for non-JSON
      return body;
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// Recording fakes for the Supabase helpers.
function makeSb({ business } = {}) {
  const calls = { get: [], post: [], patch: [], delete: [] };
  return {
    calls,
    sbGet: async (table, query) => {
      calls.get.push({ table, query });
      if (table === 'businesses') return business ? [business] : [];
      if (table === 'store_products') return [];
      return [];
    },
    sbPost: async (table, data) => {
      calls.post.push({ table, data });
      return Array.isArray(data) ? data[0] : data;
    },
    sbPatch: async (table, filter, data) => {
      calls.patch.push({ table, filter, data });
      return true;
    },
    sbDelete: async (table, filter) => {
      calls.delete.push({ table, filter });
      return true;
    },
  };
}

// ─── normalizeStoreUrl ───────────────────────────────────────────────────────

test('normalizeStoreUrl forces https and strips path/query', () => {
  assert.equal(normalizeStoreUrl('mystore.myshopify.com'), 'https://mystore.myshopify.com');
  assert.equal(normalizeStoreUrl('http://shop.example.com/products/x?utm=1#frag'), 'https://shop.example.com');
  assert.equal(normalizeStoreUrl('  https://Shop.Example.com/collections/all  '), 'https://shop.example.com');
});

test('normalizeStoreUrl rejects non-http and internal targets', () => {
  assert.equal(normalizeStoreUrl('javascript:alert(1)'), null);
  assert.equal(normalizeStoreUrl('ftp://shop.example.com'), null);
  assert.equal(normalizeStoreUrl('file:///etc/passwd'), null);
  assert.equal(normalizeStoreUrl('localhost:3000'), null);
  assert.equal(normalizeStoreUrl('http://169.254.169.254'), null);
  assert.equal(normalizeStoreUrl('not a url'), null);
  assert.equal(normalizeStoreUrl(''), null);
  assert.equal(normalizeStoreUrl(null), null);
});

// ─── fetchCatalog ────────────────────────────────────────────────────────────

test('fetchCatalog parses a Shopify products.json', async () => {
  let requested;
  const sb = makeSb();
  const svc = createShopifyService({
    ...sb,
    fetchImpl: async (url) => {
      requested = url;
      return jsonResponse(CANNED_PRODUCTS_JSON);
    },
  });
  const out = await svc.fetchCatalog('shop.example.com/some/path');
  assert.equal(requested, 'https://shop.example.com/products.json?limit=250');
  assert.equal(out.ok, true);
  assert.equal(out.products.length, 2);

  const p = out.products[0];
  assert.equal(p.external_id, '123456789'); // stringified numeric id
  assert.equal(p.title, 'Insulated Water Bottle');
  assert.ok(!p.description.includes('<'), 'html stripped');
  assert.ok(!p.description.includes('evil'), 'script stripped');
  assert.ok(p.description.length <= 2000, 'description capped at 2000');
  assert.equal(p.price, 29.99);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.image_urls.length, 8, 'images capped at 8');
  assert.equal(p.product_url, 'https://shop.example.com/products/insulated-water-bottle');
  assert.equal(p.vendor, 'HydroCo');
  assert.deepEqual(p.tags, ['hydration', 'outdoors', 'bestseller']);

  assert.equal(out.products[1].currency, 'USD', 'defaults to USD without presentment currency');
  assert.deepEqual(out.products[1].tags, ['cleaning'], 'array tags pass through');
});

test('fetchCatalog returns not_shopify on 404 / non-JSON', async () => {
  const sb = makeSb();
  const svc404 = createShopifyService({ ...sb, fetchImpl: async () => jsonResponse('nope', 404) });
  assert.equal((await svc404.fetchCatalog('https://plain-site.com')).reason, 'not_shopify');

  const svcHtml = createShopifyService({ ...sb, fetchImpl: async () => jsonResponse('<html>home</html>', 200) });
  assert.equal((await svcHtml.fetchCatalog('https://plain-site.com')).reason, 'not_shopify');

  const svcShape = createShopifyService({ ...sb, fetchImpl: async () => jsonResponse({ page: 'home' }, 200) });
  assert.equal((await svcShape.fetchCatalog('https://plain-site.com')).reason, 'not_shopify');
});

// ─── connectStore ────────────────────────────────────────────────────────────

test('connectStore upserts products + patches businesses + saves summary', async () => {
  const sb = makeSb({ business: { id: BIZ, user_id: OWNER, website_url: null } });
  let claudePrompt;
  const svc = createShopifyService({
    ...sb,
    fetchImpl: async () => jsonResponse(CANNED_PRODUCTS_JSON),
    callClaude: async (prompt) => {
      claudePrompt = prompt;
      return 'HydroCo sells insulated drinkware to outdoor enthusiasts. Lead with the 24h cold claim.';
    },
  });

  const out = await svc.connectStore({ businessId: BIZ, storeUrl: 'shop.example.com' });
  assert.equal(out.ok, true);
  assert.equal(out.platform, 'shopify');
  assert.equal(out.product_count, 2);
  assert.equal(out.summary_saved, true);

  // products replaced: delete-then-insert into store_products
  assert.deepEqual(sb.calls.delete[0], { table: 'store_products', filter: `business_id=eq.${BIZ}` });
  const insert = sb.calls.post.find((c) => c.table === 'store_products');
  assert.equal(insert.data.length, 2);
  assert.equal(insert.data[0].business_id, BIZ);
  assert.equal(insert.data[0].source, 'shopify');

  // businesses patched with store_url / store_meta / reference images / website_url backfill
  const bizPatch = sb.calls.patch.find((c) => c.table === 'businesses' && c.data.store_url);
  assert.equal(bizPatch.filter, `id=eq.${BIZ}`);
  assert.equal(bizPatch.data.store_url, 'https://shop.example.com');
  assert.equal(bizPatch.data.store_meta.platform, 'shopify');
  assert.equal(bizPatch.data.store_meta.product_count, 2);
  assert.deepEqual(bizPatch.data.store_meta.top_product_ids, ['123456789', '987654321']);
  assert.equal(bizPatch.data.website_url, 'https://shop.example.com', 'website_url backfilled when empty');
  assert.equal(bizPatch.data.product_image_urls.length, 2, 'first image per product feeds WF1 reference path');
  assert.equal(bizPatch.data.product_image_urls[0], 'https://cdn.shopify.com/img-0.jpg');

  // summary written to website_summary from ONE capped callClaude
  assert.ok(claudePrompt.includes('Insulated Water Bottle'));
  const sumPatch = sb.calls.patch.find((c) => c.table === 'businesses' && c.data.website_summary);
  assert.ok(sumPatch.data.website_summary.includes('HydroCo'));
});

test('connectStore soft-fails the summary when Claude errors', async () => {
  const sb = makeSb({ business: { id: BIZ, user_id: OWNER, website_url: 'https://existing.com' } });
  const svc = createShopifyService({
    ...sb,
    fetchImpl: async () => jsonResponse(CANNED_PRODUCTS_JSON),
    callClaude: async () => {
      throw new Error('credit outage');
    },
  });
  const out = await svc.connectStore({ businessId: BIZ, storeUrl: 'shop.example.com' });
  assert.equal(out.ok, true, 'connect still succeeds without the summary');
  assert.equal(out.summary_saved, false);
  assert.ok(!sb.calls.patch.some((c) => c.data.website_summary), 'no summary patch on failure');
  const bizPatch = sb.calls.patch.find((c) => c.data.store_url);
  assert.equal(bizPatch.data.website_url, undefined, 'existing website_url untouched');
});

test('connectStore falls back to generic summary-only mode on non-Shopify sites', async () => {
  const sb = makeSb({ business: { id: BIZ, user_id: OWNER, website_url: null } });
  const svc = createShopifyService({
    ...sb,
    fetchImpl: async (url) => {
      if (String(url).includes('/products.json')) return jsonResponse('not found', 404);
      // homepage fetch by websiteEnricher
      return jsonResponse(`<html><body>${'We sell artisan candles to cozy homes. '.repeat(5)}</body></html>`);
    },
    callClaude: async () => JSON.stringify({ summary: 'Artisan candle shop for cozy homes.' }),
    extractJSON: (raw) => JSON.parse(raw),
  });
  const out = await svc.connectStore({ businessId: BIZ, storeUrl: 'https://plain-site.com' });
  assert.equal(out.ok, true);
  assert.equal(out.platform, 'generic');
  assert.equal(out.product_count, 0);
  assert.equal(out.summary_saved, true);
  assert.equal(sb.calls.post.length, 0, 'no store_products writes for generic sites');
  const patch = sb.calls.patch.find((c) => c.table === 'businesses');
  assert.equal(patch.data.store_meta.platform, 'generic');
  assert.equal(patch.data.website_summary, 'Artisan candle shop for cozy homes.');
});

test('connectStore rejects an invalid business_id before any DB call', async () => {
  const sb = makeSb();
  const svc = createShopifyService({ ...sb, fetchImpl: async () => jsonResponse(CANNED_PRODUCTS_JSON) });
  await assert.rejects(
    () => svc.connectStore({ businessId: 'not-a-uuid; drop table', storeUrl: 'shop.example.com' }),
    /invalid business_id/
  );
  assert.equal(sb.calls.get.length, 0);
});

// ─── setAutomation ───────────────────────────────────────────────────────────

test('setAutomation patches autopilot + autonomy mode (never ads_live)', async () => {
  const sb = makeSb();
  const svc = createShopifyService({ ...sb, fetchImpl: async () => jsonResponse({}) });

  const on = await svc.setAutomation({ businessId: BIZ, enabled: true });
  assert.deepEqual(on, { ok: true, autopilot_enabled: true, wf1_autonomy_mode: 'full_autopilot' });
  assert.deepEqual(sb.calls.patch[0], {
    table: 'businesses',
    filter: `id=eq.${BIZ}`,
    data: { autopilot_enabled: true, wf1_autonomy_mode: 'full_autopilot' },
  });
  assert.ok(!('ads_live' in sb.calls.patch[0].data), 'ads_live consent is a separate flow');

  await svc.setAutomation({ businessId: BIZ, enabled: false });
  assert.deepEqual(sb.calls.patch[1].data, { autopilot_enabled: false, wf1_autonomy_mode: 'hybrid' });
});

// ─── routes: ownership ───────────────────────────────────────────────────────

function makeApp() {
  const routes = {};
  const collect =
    (method) =>
    (path, ...handlers) => {
      routes[`${method} ${path}`] = handlers[handlers.length - 1];
    };
  return { routes, app: { post: collect('POST'), get: collect('GET') } };
}

function makeRes() {
  return {
    statusCode: 200,
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
  return res.status(status).json({ error: { code, message } });
}

test('routes reject a foreign business_id with 403', async () => {
  const { routes, app } = makeApp();
  const sb = makeSb({ business: { id: BIZ, user_id: OWNER } });
  let connectCalled = false;
  shopifyRoutes.register({
    app,
    shopify: {
      connectStore: async () => {
        connectCalled = true;
        return { ok: true };
      },
      getProducts: async () => [],
      syncStore: async () => ({ ok: true }),
      setAutomation: async () => ({ ok: true }),
    },
    requireAnyUserId: (_req, _res, next) => next(),
    businessForUser: async () => null,
    apiError,
    sbGet: sb.sbGet,
    log: () => {},
  });

  const res = makeRes();
  await routes['POST /api/store/connect'](
    { user: { id: STRANGER }, body: { business_id: BIZ, store_url: 'shop.example.com' } },
    res
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'FORBIDDEN');
  assert.equal(connectCalled, false, 'service never invoked for a foreign business');

  // owner passes through
  const okRes = makeRes();
  await routes['POST /api/store/connect'](
    { user: { id: OWNER }, body: { business_id: BIZ, store_url: 'shop.example.com' } },
    okRes
  );
  assert.equal(okRes.statusCode, 200);
  assert.equal(connectCalled, true);

  // invalid UUID → 400, unknown business → 404
  const badRes = makeRes();
  await routes['GET /api/store/products']({ user: { id: OWNER }, query: { business_id: 'zzz' } }, badRes);
  assert.equal(badRes.statusCode, 400);

  const sbEmpty = makeSb({ business: null });
  const { routes: r2, app: app2 } = makeApp();
  shopifyRoutes.register({
    app: app2,
    shopify: { getProducts: async () => [] },
    requireAnyUserId: (_req, _res, next) => next(),
    apiError,
    sbGet: sbEmpty.sbGet,
    log: () => {},
  });
  const missRes = makeRes();
  await r2['GET /api/store/products']({ user: { id: OWNER }, query: { business_id: BIZ } }, missRes);
  assert.equal(missRes.statusCode, 404);
});

test('automation route validates enabled and forwards to the service', async () => {
  const { routes, app } = makeApp();
  const sb = makeSb({ business: { id: BIZ, user_id: OWNER } });
  const seen = [];
  shopifyRoutes.register({
    app,
    shopify: {
      setAutomation: async (args) => {
        seen.push(args);
        return { ok: true, autopilot_enabled: args.enabled };
      },
    },
    requireAnyUserId: (_req, _res, next) => next(),
    apiError,
    sbGet: sb.sbGet,
    log: () => {},
  });

  const bad = makeRes();
  await routes['POST /api/store/automation']({ user: { id: OWNER }, body: { business_id: BIZ, enabled: 'yes' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(seen.length, 0);

  const good = makeRes();
  await routes['POST /api/store/automation']({ user: { id: OWNER }, body: { business_id: BIZ, enabled: true } }, good);
  assert.equal(good.statusCode, 200);
  assert.deepEqual(seen[0], { businessId: BIZ, enabled: true });
});
