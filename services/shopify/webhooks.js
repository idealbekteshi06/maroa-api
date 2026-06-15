'use strict';

/**
 * services/shopify/webhooks.js — Shopify webhook ingress (public, HMAC-verified).
 *
 * These routes are registered in server.js BEFORE express.json() so req.body is
 * the raw Buffer the HMAC is computed over (same as the Paddle/Stripe webhooks).
 * Because they're registered before the global `app.use('/webhook', requireAuth…)`
 * mount, they bypass the n8n secret-auth (Shopify can't send our header) and
 * instead authenticate with the Shopify HMAC.
 *
 * Contract for every handler (matches the task's <5s rule):
 *   1. Verify X-Shopify-Hmac-Sha256 over the RAW body. Reject 401 on mismatch.
 *   2. Idempotency via lib/webhookEvents keyed on X-Shopify-Webhook-Id (unique
 *      per delivery) — Shopify has no signed timestamp, so this is the replay
 *      guard.
 *   3. Resolve the owning business by X-Shopify-Shop-Domain.
 *   4. ENQUEUE the real work to Inngest and return 200 immediately. No backfill,
 *      no GraphQL, no heavy DB writes in the request cycle.
 *
 * Topic routing:
 *   orders/* · checkouts/* · products/*  → maroa/shopify.resource.ingest
 *   app/uninstalled · shop/redact         → maroa/shopify.store.purge
 *   customers/redact                      → maroa/shopify.customer.redact
 *   customers/data_request                → recorded (fulfilled out-of-band)
 */

const webhookEvents = require('../../lib/webhookEvents');
const { verifyWebhookHmac } = require('../../lib/shopify/hmac');
const store = require('./store');

const WEBHOOK_PATHS = [
  'orders-create',
  'orders-paid',
  'checkouts-create',
  'products-update',
  'app-uninstalled',
  // Mandatory GDPR/compliance topics (configured in the Partner Dashboard).
  'customers-data-request',
  'customers-redact',
  'shop-redact',
];

const PROVIDER = 'shopify';

function buildShopifyWebhookHandler({ sbGet, sbPost, sbPatch, logger, inngest, secret }) {
  // `secret` is supplied by the caller (server.js reads it from the validated
  // env; tests pass it explicitly) as a string or a getter function.
  const getSecret = typeof secret === 'function' ? secret : () => secret || '';

  return async function shopifyWebhookHandler(req, res) {
    const sec = getSecret();
    if (!sec) {
      return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'SHOPIFY_API_SECRET not set' } });
    }

    const rawBody = req.body;
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'raw body required' } });
    }
    if (!verifyWebhookHmac(rawBody, hmacHeader, sec)) {
      logger?.warn?.('/webhook/shopify', null, 'HMAC verification failed', { request_id: req.requestId });
      return res.status(401).json({ error: { code: 'INVALID_HMAC', message: 'HMAC verification failed' } });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'could not parse body' } });
    }

    const topic = req.get('X-Shopify-Topic') || '';
    const shopDomain = req.get('X-Shopify-Shop-Domain') || '';
    // X-Shopify-Webhook-Id is unique per delivery — the canonical dedup key.
    const eventId = req.get('X-Shopify-Webhook-Id') || `${topic}:${payload?.id || ''}`;

    const dedup = await webhookEvents.markProcessed({ provider: PROVIDER, eventId, sbPost, sbPatch, sbGet, logger });
    if (!dedup.firstTime) {
      logger?.info?.('/webhook/shopify', null, 'duplicate webhook — skipping', { topic, event_id: eventId });
      return res.json({ received: true, duplicate: true });
    }

    let ok = true;
    let errMsg = null;
    try {
      const biz = await store.resolveBusinessByShop({ sbGet }, shopDomain);
      const businessId = biz?.id || null;

      if (!businessId && topic !== 'shop/redact' && topic !== 'customers/data_request') {
        // Unknown store (e.g. already purged). Ack so Shopify stops retrying.
        logger?.warn?.('/webhook/shopify', null, 'no business for shop', { topic, shop: shopDomain });
      } else if (topic === 'app/uninstalled' || topic === 'shop/redact') {
        if (businessId && inngest?.send) {
          await inngest.send({
            name: 'maroa/shopify.store.purge',
            data: { businessId, reason: topic === 'shop/redact' ? 'shop_redact' : 'app_uninstalled' },
          });
        }
      } else if (topic === 'customers/redact') {
        const email = payload?.customer?.email || payload?.email || null;
        if (businessId && inngest?.send) {
          await inngest.send({ name: 'maroa/shopify.customer.redact', data: { businessId, email } });
        }
      } else if (topic === 'customers/data_request') {
        // We hold only order/checkout rows; fulfillment is manual/out-of-band.
        // The dedup row in webhook_events is the receipt. Nothing to delete.
        logger?.info?.('/webhook/shopify', businessId, 'customers/data_request received', { shop: shopDomain });
      } else if (businessId && inngest?.send) {
        await inngest.send({ name: 'maroa/shopify.resource.ingest', data: { businessId, topic, payload } });
      }
    } catch (e) {
      ok = false;
      errMsg = e.message;
      logger?.error?.('/webhook/shopify', null, 'handler error', { topic, error: e.message });
    }

    await webhookEvents
      .commitProcessed({
        provider: PROVIDER,
        eventId,
        status: ok ? 'processed' : 'failed',
        sbPatch,
        logger,
        error: ok ? null : errMsg,
      })
      .catch(() => {});

    if (!ok) {
      webhookEvents.forgetEvent(PROVIDER, eventId);
      return res.status(500).json({ error: { code: 'HANDLER_ERROR', message: 'event processing error' } });
    }
    return res.json({ received: true });
  };
}

/**
 * Register the HMAC-verified ingress routes. MUST be called before
 * express.json() so the handler sees the raw Buffer.
 */
function registerShopifyWebhookRoutes({ app, express, sbGet, sbPost, sbPatch, logger, inngest, secret }) {
  const raw = express.raw({ type: 'application/json' });
  const handler = buildShopifyWebhookHandler({ sbGet, sbPost, sbPatch, logger, inngest, secret });
  for (const p of WEBHOOK_PATHS) {
    app.post(`/webhook/shopify/${p}`, raw, handler);
  }
}

module.exports = {
  registerShopifyWebhookRoutes,
  buildShopifyWebhookHandler,
  WEBHOOK_PATHS,
  PROVIDER,
};
