'use strict';

/**
 * services/shopify/index.js — barrel for the Shopify public-app integration.
 *
 * Wiring (server.js):
 *   - registerShopifyWebhookRoutes  → mounted BEFORE express.json() (raw body,
 *     Shopify-HMAC auth) alongside the Paddle/Stripe webhooks.
 *   - registerShopifyOAuthRoutes    → mounted with the Meta/Google OAuth routes
 *     (has verifyUserJwt + inngest in scope).
 *   - registerShopifyWorkerRoutes   → mounted under /webhook (n8n-secret auth);
 *     driven by the Inngest functions in services/inngest/functions.js.
 */

const { registerShopifyOAuthRoutes, buildShopifyOAuthHandlers } = require('./oauth');
const { registerShopifyWebhookRoutes, buildShopifyWebhookHandler } = require('./webhooks');
const { registerShopifyDispatch } = require('./registerRoutes');
const { buildShopifyWorkerHandlers } = require('./workers');
const sync = require('./sync');
const store = require('./store');

module.exports = {
  registerShopifyOAuthRoutes,
  registerShopifyWebhookRoutes,
  registerShopifyDispatch,
  buildShopifyOAuthHandlers,
  buildShopifyWebhookHandler,
  buildShopifyWorkerHandlers,
  sync,
  store,
};
