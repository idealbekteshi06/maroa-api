'use strict';

/**
 * services/shopify/store.js — tenant-scoped persistence for Shopify data.
 *
 * The app talks to Supabase with the service-role key, which BYPASSES RLS
 * (migration 095 policies are defense-in-depth). So tenant isolation is
 * enforced HERE: every read, upsert, delete validates business_id is a UUID,
 * encodeURIComponent()s it, and includes `business_id=eq.<id>` in the filter.
 * There is no code path that reads or writes a Shopify row without a business_id
 * scope — that's what keeps store A from ever seeing store B's products/orders.
 *
 * All functions take the Supabase helpers via `deps` so they're unit-testable
 * with fakes and never reach a real database in CI.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function assertBusinessId(businessId) {
  if (!isUuid(businessId)) {
    throw new Error('shopify store: business_id must be a valid UUID');
  }
  return encodeURIComponent(businessId);
}

// Shopify GraphQL ids are gids ("gid://shopify/Product/123"); REST/webhook ids
// are bare numbers. Normalize both to the trailing id string.
function normalizeId(id) {
  if (id === null || id === undefined) return null;
  const s = String(id);
  const m = /\/([^/]+)$/.exec(s);
  return m ? m[1] : s;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── Webhook (REST-shaped) payload → row mappers ─────────────────────────────

function mapProductWebhook(p = {}) {
  return {
    shopify_product_id: normalizeId(p.id),
    title: p.title ?? null,
    handle: p.handle ?? null,
    status: p.status ?? null,
    product_type: p.product_type ?? null,
    vendor: p.vendor ?? null,
    tags: typeof p.tags === 'string' ? p.tags : Array.isArray(p.tags) ? p.tags.join(', ') : null,
    price: toNumber(p.variants?.[0]?.price),
    image_url: p.image?.src ?? p.images?.[0]?.src ?? null,
    shopify_updated_at: p.updated_at ?? null,
    raw_data: p,
  };
}

function mapOrderWebhook(o = {}) {
  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ').trim();
  return {
    shopify_order_id: normalizeId(o.id),
    order_number: o.order_number != null ? String(o.order_number) : (o.name ?? null),
    customer_email: o.email ?? o.customer?.email ?? null,
    customer_name: name || null,
    financial_status: o.financial_status ?? null,
    fulfillment_status: o.fulfillment_status ?? null,
    total_price: toNumber(o.total_price ?? o.current_total_price),
    currency: o.currency ?? o.presentment_currency ?? null,
    line_items_count: Array.isArray(o.line_items) ? o.line_items.length : null,
    shopify_created_at: o.created_at ?? null,
    raw_data: o,
  };
}

function mapCheckoutWebhook(c = {}) {
  return {
    shopify_checkout_id: normalizeId(c.id ?? c.token),
    checkout_token: c.token ?? null,
    customer_email: c.email ?? c.customer?.email ?? null,
    total_price: toNumber(c.total_price),
    currency: c.currency ?? c.presentment_currency ?? null,
    abandoned_checkout_url: c.abandoned_checkout_url ?? null,
    completed_at: c.completed_at ?? null,
    shopify_created_at: c.created_at ?? null,
    raw_data: c,
  };
}

const TABLES = {
  products: { table: 'shopify_products', idCol: 'shopify_product_id' },
  orders: { table: 'shopify_orders', idCol: 'shopify_order_id' },
  checkouts: { table: 'shopify_checkouts', idCol: 'shopify_checkout_id' },
};

/**
 * Read-first upsert, scoped by (business_id, <idCol>). Uses only sbGet/sbPost/
 * sbPatch so it works with the existing service-role helpers (no PostgREST
 * merge-duplicates header needed). Idempotent: the same Shopify resource
 * delivered twice updates in place rather than duplicating.
 */
async function upsertRow({ sbGet, sbPost, sbPatch }, kind, businessId, row) {
  const safeBiz = assertBusinessId(businessId);
  const { table, idCol } = TABLES[kind];
  const idValue = row[idCol];
  if (!idValue) throw new Error(`shopify store: missing ${idCol}`);
  const safeId = encodeURIComponent(String(idValue));
  const scope = `business_id=eq.${safeBiz}&${idCol}=eq.${safeId}`;

  const existing = await sbGet(table, `${scope}&select=id&limit=1`);
  if (Array.isArray(existing) && existing.length > 0) {
    await sbPatch(table, scope, { ...row, synced_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return { action: 'updated', table };
  }
  await sbPost(table, { business_id: businessId, ...row });
  return { action: 'inserted', table };
}

function upsertProductRow(deps, businessId, row) {
  return upsertRow(deps, 'products', businessId, row);
}
function upsertOrderRow(deps, businessId, row) {
  return upsertRow(deps, 'orders', businessId, row);
}
function upsertCheckoutRow(deps, businessId, row) {
  return upsertRow(deps, 'checkouts', businessId, row);
}

// Topic → mapper + upsert. Returns { action } or { skipped } for unknown topics.
async function ingestWebhook(deps, businessId, topic, payload) {
  switch (topic) {
    case 'orders/create':
    case 'orders/paid':
    case 'orders/updated':
      return upsertOrderRow(deps, businessId, mapOrderWebhook(payload));
    case 'products/update':
    case 'products/create':
      return upsertProductRow(deps, businessId, mapProductWebhook(payload));
    case 'checkouts/create':
    case 'checkouts/update':
      return upsertCheckoutRow(deps, businessId, mapCheckoutWebhook(payload));
    default:
      return { skipped: true, reason: `unhandled topic ${topic}` };
  }
}

/** Resolve which business owns a Shopify store, by its shop domain. */
async function resolveBusinessByShop({ sbGet }, shopDomain) {
  if (!shopDomain || typeof shopDomain !== 'string') return null;
  const rows = await sbGet(
    'businesses',
    `shopify_shop_domain=eq.${encodeURIComponent(shopDomain)}&select=id,shopify_access_token_enc&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * GDPR-safe purge of a store's synced data + token (app/uninstalled, shop/redact).
 * Deletes are scoped by business_id; the businesses row is kept but its Shopify
 * token/connection columns are cleared.
 */
async function purgeStore({ sbDelete, sbPatch }, businessId) {
  const safeBiz = assertBusinessId(businessId);
  const filter = `business_id=eq.${safeBiz}`;
  const deleted = {};
  for (const kind of Object.keys(TABLES)) {
    const { table } = TABLES[kind];
    await sbDelete(table, filter);
    deleted[table] = true;
  }
  await sbPatch('businesses', `id=eq.${safeBiz}`, {
    shopify_access_token_enc: null,
    shopify_connected: false,
    shopify_uninstalled_at: new Date().toISOString(),
  });
  return { purged: deleted };
}

/**
 * GDPR customer redaction (customers/redact): remove a single customer's PII
 * from this store's synced orders/checkouts. Scoped by business_id + email.
 */
async function redactCustomer({ sbDelete }, businessId, { email } = {}) {
  const safeBiz = assertBusinessId(businessId);
  if (!email || typeof email !== 'string') return { redacted: 0, reason: 'no email' };
  const safeEmail = encodeURIComponent(email);
  await sbDelete('shopify_orders', `business_id=eq.${safeBiz}&customer_email=eq.${safeEmail}`);
  await sbDelete('shopify_checkouts', `business_id=eq.${safeBiz}&customer_email=eq.${safeEmail}`);
  return { redacted: 1 };
}

// ─── Scoped dashboard reads ──────────────────────────────────────────────────
async function getProductsForBusiness({ sbGet }, businessId, { limit = 100 } = {}) {
  const safeBiz = assertBusinessId(businessId);
  const lim = Math.min(250, Math.max(1, Number(limit) || 100));
  return sbGet('shopify_products', `business_id=eq.${safeBiz}&order=synced_at.desc&limit=${lim}&select=*`);
}
async function getOrdersForBusiness({ sbGet }, businessId, { limit = 100 } = {}) {
  const safeBiz = assertBusinessId(businessId);
  const lim = Math.min(250, Math.max(1, Number(limit) || 100));
  return sbGet('shopify_orders', `business_id=eq.${safeBiz}&order=created_at.desc&limit=${lim}&select=*`);
}

module.exports = {
  isUuid,
  normalizeId,
  toNumber,
  mapProductWebhook,
  mapOrderWebhook,
  mapCheckoutWebhook,
  upsertProductRow,
  upsertOrderRow,
  upsertCheckoutRow,
  ingestWebhook,
  resolveBusinessByShop,
  purgeStore,
  redactCustomer,
  getProductsForBusiness,
  getOrdersForBusiness,
  TABLES,
};
