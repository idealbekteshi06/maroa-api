'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const store = require('../services/shopify/store');

const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ─── Fake service-role Supabase that ACTUALLY honors business_id filters ─────
// Mirrors how PostgREST applies `col=eq.value`. Proves the store layer's
// manual scoping isolates tenants (the app uses the service-role key, which
// bypasses RLS — so this scoping is the real guard).
function parseEqFilters(query) {
  const filters = {};
  for (const part of String(query).split('&')) {
    const m = /^([a-zA-Z_]+)=eq\.(.+)$/.exec(part);
    if (m) filters[m[1]] = decodeURIComponent(m[2]);
  }
  return filters;
}
function rowMatches(row, filters) {
  return Object.entries(filters).every(([k, v]) => String(row[k]) === String(v));
}

function makeFakeDb(seed = {}) {
  const tables = JSON.parse(JSON.stringify(seed));
  const calls = { get: [], post: [], patch: [], delete: [] };
  let idSeq = 1;
  return {
    tables,
    calls,
    sbGet: async (table, query = '') => {
      calls.get.push({ table, query });
      const rows = tables[table] || [];
      return rows.filter((r) => rowMatches(r, parseEqFilters(query)));
    },
    sbPost: async (table, data) => {
      calls.post.push({ table, data });
      tables[table] = tables[table] || [];
      const row = { id: `row-${idSeq++}`, ...data };
      tables[table].push(row);
      return row;
    },
    sbPatch: async (table, filter, data) => {
      calls.patch.push({ table, filter, data });
      const filters = parseEqFilters(filter);
      (tables[table] || []).forEach((r) => {
        if (rowMatches(r, filters)) Object.assign(r, data);
      });
      return true;
    },
    sbDelete: async (table, filter) => {
      calls.delete.push({ table, filter });
      const filters = parseEqFilters(filter);
      tables[table] = (tables[table] || []).filter((r) => !rowMatches(r, filters));
      return true;
    },
  };
}

// ─── Cross-tenant read isolation ─────────────────────────────────────────────

test('scoping: a business only reads its OWN products/orders', async () => {
  const db = makeFakeDb({
    shopify_products: [
      { id: 'p1', business_id: BIZ_A, shopify_product_id: '1', title: 'A-product' },
      { id: 'p2', business_id: BIZ_B, shopify_product_id: '2', title: 'B-product' },
    ],
    shopify_orders: [
      { id: 'o1', business_id: BIZ_A, shopify_order_id: '10' },
      { id: 'o2', business_id: BIZ_B, shopify_order_id: '20' },
    ],
  });

  const aProducts = await store.getProductsForBusiness(db, BIZ_A);
  assert.equal(aProducts.length, 1);
  assert.equal(aProducts[0].title, 'A-product');
  assert.ok(aProducts.every((r) => r.business_id === BIZ_A));

  const bOrders = await store.getOrdersForBusiness(db, BIZ_B);
  assert.equal(bOrders.length, 1);
  assert.ok(bOrders.every((r) => r.business_id === BIZ_B));

  // Every read query carried an explicit business_id scope.
  assert.ok(db.calls.get.every((c) => /business_id=eq\./.test(c.query)));
});

test('scoping: invalid business_id is rejected before any query', async () => {
  const db = makeFakeDb();
  await assert.rejects(() => store.getProductsForBusiness(db, 'not-a-uuid'), /valid UUID/);
  await assert.rejects(() => store.upsertProductRow(db, '', { shopify_product_id: '1' }), /valid UUID/);
  assert.equal(db.calls.get.length, 0);
  assert.equal(db.calls.post.length, 0);
});

// ─── Writes are scoped + idempotent ──────────────────────────────────────────

test('scoping: upsert inserts with business_id, updates in place on repeat', async () => {
  const db = makeFakeDb({ shopify_products: [] });
  await store.upsertProductRow(db, BIZ_A, { shopify_product_id: '1', title: 'v1' });
  assert.equal(db.tables.shopify_products.length, 1);
  assert.equal(db.calls.post[0].data.business_id, BIZ_A);

  // Same Shopify id again → update, not a second row (idempotent webhook).
  await store.upsertProductRow(db, BIZ_A, { shopify_product_id: '1', title: 'v2' });
  assert.equal(db.tables.shopify_products.length, 1);
  assert.equal(db.tables.shopify_products[0].title, 'v2');
  assert.ok(db.calls.patch.every((c) => /business_id=eq\./.test(c.filter)));
});

test('scoping: ingestWebhook maps order payload into a scoped row', async () => {
  const db = makeFakeDb({ shopify_orders: [] });
  await store.ingestWebhook(db, BIZ_A, 'orders/create', {
    id: 555,
    order_number: 1001,
    email: 'buyer@example.com',
    total_price: '42.00',
    currency: 'USD',
    line_items: [{}, {}],
    customer: { first_name: 'Jo', last_name: 'Lee' },
  });
  const row = db.tables.shopify_orders[0];
  assert.equal(row.business_id, BIZ_A);
  assert.equal(row.shopify_order_id, '555');
  assert.equal(row.customer_name, 'Jo Lee');
  assert.equal(row.total_price, 42);
  assert.equal(row.line_items_count, 2);
});

// ─── GDPR purge / redact stay scoped ─────────────────────────────────────────

test('scoping: purgeStore deletes only the target business + nulls its token', async () => {
  const db = makeFakeDb({
    shopify_products: [
      { id: 'p1', business_id: BIZ_A, shopify_product_id: '1' },
      { id: 'p2', business_id: BIZ_B, shopify_product_id: '2' },
    ],
    shopify_orders: [{ id: 'o2', business_id: BIZ_B, shopify_order_id: '20' }],
    shopify_checkouts: [],
  });
  await store.purgeStore(db, BIZ_A);
  // A's rows gone, B's untouched.
  assert.equal(db.tables.shopify_products.length, 1);
  assert.equal(db.tables.shopify_products[0].business_id, BIZ_B);
  assert.ok(db.calls.delete.every((c) => c.filter === `business_id=eq.${BIZ_A}`));
  // Token cleared on the businesses row, scoped to A.
  const patch = db.calls.patch.find((c) => c.table === 'businesses');
  assert.equal(patch.filter, `id=eq.${BIZ_A}`);
  assert.equal(patch.data.shopify_access_token_enc, null);
  assert.equal(patch.data.shopify_connected, false);
});

test('scoping: redactCustomer is scoped by business_id AND email', async () => {
  const db = makeFakeDb({ shopify_orders: [], shopify_checkouts: [] });
  await store.redactCustomer(db, BIZ_A, { email: 'gone@example.com' });
  assert.ok(
    db.calls.delete.every(
      (c) => c.filter.includes(`business_id=eq.${BIZ_A}`) && c.filter.includes('customer_email=eq.')
    )
  );
});

// ─── Migration RLS shape matches 091 ─────────────────────────────────────────

test('scoping: migration 095 hardens RLS the same way as 091', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '095_shopify_integration.sql'), 'utf8');
  for (const table of ['shopify_products', 'shopify_orders', 'shopify_checkouts']) {
    assert.ok(sql.includes(`_maroa_harden_rls('${table}', 'business_id')`), `missing RLS harden for ${table}`);
  }
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS must be enabled');
  assert.ok(sql.includes('FOR ALL TO service_role'), 'service_role policy present');
  assert.ok(sql.includes('FOR SELECT TO authenticated'), 'owner_read policy present');
  assert.ok(sql.includes('DROP FUNCTION _maroa_harden_rls(text, text)'), 'helper dropped like 091');
});
