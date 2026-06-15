'use strict';

/**
 * services/shopify/sync.js — install-time work for a single store.
 *
 *   1. registerWebhooks() — subscribe the per-store business topics via the
 *      GraphQL Admin API (webhookSubscriptionCreate). This is plumbing, not an
 *      outward/money action, so it is NOT gated by SHOPIFY_SYNC_LIVE — without
 *      it the app receives no events at all. The three mandatory GDPR/compliance
 *      webhooks (customers/data_request, customers/redact, shop/redact) are NOT
 *      registered here: Shopify delivers those based on the URLs configured in
 *      the Partner Dashboard app settings.
 *   2. backfillProducts()/backfillOrders() — page the store's catalog + recent
 *      orders into shopify_products / shopify_orders via the tenant-scoped store
 *      layer. Reads only; spends/post nothing outward.
 *
 * Tokens are decrypted from businesses.shopify_access_token_enc with the same
 * helper used everywhere else (lib/oauthCrypto.readToken).
 */

const oauthCrypto = require('../../lib/oauthCrypto');
const { shopifyGraphQL } = require('../../lib/shopify/client');
const { isValidShopDomain } = require('../../lib/shopify/hmac');
const store = require('./store');

const MAX_PAGES = 20; // 20 pages * 50 = up to 1000 rows per backfill — bounded.

// Business topic → our HMAC-verified ingress route.
const WEBHOOK_TOPICS = [
  { topic: 'ORDERS_CREATE', path: '/webhook/shopify/orders-create' },
  { topic: 'ORDERS_PAID', path: '/webhook/shopify/orders-paid' },
  { topic: 'CHECKOUTS_CREATE', path: '/webhook/shopify/checkouts-create' },
  { topic: 'PRODUCTS_UPDATE', path: '/webhook/shopify/products-update' },
  { topic: 'APP_UNINSTALLED', path: '/webhook/shopify/app-uninstalled' },
];

function appOrigin() {
  // Validated env (Rule 1). Only invoked at server runtime (webhook registration).
  const env = require('../../lib/env').parse();
  const explicit = env.SHOPIFY_APP_URL || '';
  if (explicit) return explicit.replace(/\/$/, '');
  try {
    return new URL(env.SHOPIFY_OAUTH_REDIRECT_URI || '').origin;
  } catch {
    return 'https://maroa-api-production.up.railway.app';
  }
}

/** Fetch a business's shop domain + decrypted offline token. */
async function getStoreCreds({ sbGet }, businessId) {
  const safeBiz = encodeURIComponent(businessId);
  const rows = await sbGet(
    'businesses',
    `id=eq.${safeBiz}&select=id,shopify_shop_domain,shopify_access_token_enc&limit=1`
  );
  const row = Array.isArray(rows) && rows[0];
  if (!row || !row.shopify_shop_domain) return null;
  const accessToken = oauthCrypto.readToken(row, 'shopify_access_token');
  if (!accessToken) return null;
  return { shop: row.shopify_shop_domain, accessToken };
}

const WEBHOOK_CREATE_MUTATION = `
  mutation shopifyWebhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

async function registerWebhooks(apiRequest, { shop, accessToken, logger }) {
  if (!isValidShopDomain(shop)) throw new Error('registerWebhooks: invalid shop');
  const origin = appOrigin();
  const results = [];
  for (const { topic, path } of WEBHOOK_TOPICS) {
    const variables = { topic, sub: { callbackUrl: `${origin}${path}`, format: 'JSON' } };
    try {
      const data = await shopifyGraphQL(apiRequest, {
        shop,
        accessToken,
        query: WEBHOOK_CREATE_MUTATION,
        variables,
        logger,
      });
      const userErrors = data?.webhookSubscriptionCreate?.userErrors || [];
      // "address taken"/already-exists is benign on re-install — treat as ok.
      results.push({ topic, ok: userErrors.length === 0, userErrors });
    } catch (e) {
      logger?.warn?.('/shopify/sync', null, 'webhook register failed', { shop, topic, error: e.message });
      results.push({ topic, ok: false, error: e.message });
    }
  }
  return results;
}

const PRODUCTS_QUERY = `
  query shopifyProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle status productType vendor tags updatedAt
        featuredImage { url }
        variants(first: 1) { nodes { price } }
      }
    }
  }
`;

function mapProductNode(n) {
  return {
    shopify_product_id: store.normalizeId(n.id),
    title: n.title ?? null,
    handle: n.handle ?? null,
    status: typeof n.status === 'string' ? n.status.toLowerCase() : null,
    product_type: n.productType ?? null,
    vendor: n.vendor ?? null,
    tags: Array.isArray(n.tags) ? n.tags.join(', ') : (n.tags ?? null),
    price: store.toNumber(n.variants?.nodes?.[0]?.price),
    image_url: n.featuredImage?.url ?? null,
    shopify_updated_at: n.updatedAt ?? null,
    raw_data: n,
  };
}

const ORDERS_QUERY = `
  query shopifyOrders($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name email displayFinancialStatus displayFulfillmentStatus createdAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { firstName lastName email }
      }
    }
  }
`;

function mapOrderNode(n) {
  const name = [n.customer?.firstName, n.customer?.lastName].filter(Boolean).join(' ').trim();
  return {
    shopify_order_id: store.normalizeId(n.id),
    order_number: n.name ?? null,
    customer_email: n.email ?? n.customer?.email ?? null,
    customer_name: name || null,
    financial_status: n.displayFinancialStatus ?? null,
    fulfillment_status: n.displayFulfillmentStatus ?? null,
    total_price: store.toNumber(n.currentTotalPriceSet?.shopMoney?.amount),
    currency: n.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
    line_items_count: null,
    shopify_created_at: n.createdAt ?? null,
    raw_data: n,
  };
}

async function backfillConnection(
  apiRequest,
  deps,
  { shop, accessToken, businessId, logger },
  query,
  key,
  mapNode,
  upsert
) {
  let cursor = null;
  let synced = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await shopifyGraphQL(apiRequest, { shop, accessToken, query, variables: { cursor }, logger });
    const conn = data?.[key];
    const nodes = conn?.nodes || [];
    for (const n of nodes) {
      await upsert(deps, businessId, mapNode(n));
      synced += 1;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return synced;
}

function backfillProducts(apiRequest, deps, ctx) {
  return backfillConnection(apiRequest, deps, ctx, PRODUCTS_QUERY, 'products', mapProductNode, store.upsertProductRow);
}
function backfillOrders(apiRequest, deps, ctx) {
  return backfillConnection(apiRequest, deps, ctx, ORDERS_QUERY, 'orders', mapOrderNode, store.upsertOrderRow);
}

/** Full install-time sync for one business: register webhooks + backfill. */
async function runInitialSync(apiRequest, deps, { businessId, logger }) {
  const creds = await getStoreCreds(deps, businessId);
  if (!creds) return { ok: false, reason: 'store not connected' };
  const { shop, accessToken } = creds;
  const ctx = { shop, accessToken, businessId, logger };

  const webhooks = await registerWebhooks(apiRequest, { shop, accessToken, logger });
  const products = await backfillProducts(apiRequest, deps, ctx).catch((e) => {
    logger?.warn?.('/shopify/sync', businessId, 'product backfill failed', { error: e.message });
    return 0;
  });
  const orders = await backfillOrders(apiRequest, deps, ctx).catch((e) => {
    logger?.warn?.('/shopify/sync', businessId, 'order backfill failed', { error: e.message });
    return 0;
  });

  return { ok: true, webhooks, products, orders };
}

module.exports = {
  runInitialSync,
  registerWebhooks,
  backfillProducts,
  backfillOrders,
  getStoreCreds,
  appOrigin,
  mapProductNode,
  mapOrderNode,
  WEBHOOK_TOPICS,
};
