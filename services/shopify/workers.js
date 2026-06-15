'use strict';

/**
 * services/shopify/workers.js — the heavy work the webhook ingress deferred.
 *
 * These are plain async (body) => result handlers, registered with the
 * in-process internalDispatcher in services/shopify/registerRoutes.js. The
 * Shopify Inngest functions reach them via callInternal('/webhook/shopify-*'),
 * which dispatches in-process (no HTTP loopback) just like the other migrated
 * crons. Handlers THROW on failure so the Inngest step retries (same contract
 * as an HTTP 5xx).
 *
 * They're never exposed as public HTTP routes — only Inngest (running inside
 * this process) invokes them — so there's no external/tenant attack surface;
 * tenant scoping is still enforced by the store layer's business_id checks.
 */

const sync = require('./sync');
const store = require('./store');

function buildShopifyWorkerHandlers({ apiRequest, sbGet, sbPost, sbPatch, sbDelete, logger }) {
  const storeDeps = { sbGet, sbPost, sbPatch, sbDelete, logger };

  return {
    // Register webhooks + backfill products/orders for a freshly-connected store.
    async initialSync(body) {
      const businessId = body?.businessId;
      return sync.runInitialSync(apiRequest, { sbGet, sbPost, sbPatch }, { businessId, logger });
    },

    // Upsert a single product/order/checkout from a webhook payload.
    async ingestResource(body) {
      const { businessId, topic, payload } = body || {};
      const result = await store.ingestWebhook(storeDeps, businessId, topic, payload);
      return { ok: true, ...result };
    },

    // app/uninstalled + shop/redact: delete synced rows + clear the token.
    async purgeStore(body) {
      const result = await store.purgeStore(storeDeps, body?.businessId);
      logger?.info?.('/shopify/worker', body?.businessId, 'store purged', { reason: body?.reason });
      return { ok: true, ...result };
    },

    // customers/redact: remove a single customer's PII for this store.
    async redactCustomer(body) {
      const result = await store.redactCustomer(storeDeps, body?.businessId, { email: body?.email });
      return { ok: true, ...result };
    },
  };
}

module.exports = { buildShopifyWorkerHandlers };
