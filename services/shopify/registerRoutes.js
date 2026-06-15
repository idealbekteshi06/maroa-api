'use strict';

/**
 * services/shopify/registerRoutes.js — register the Shopify worker handlers with
 * the in-process internalDispatcher.
 *
 * The Shopify Inngest functions (services/inngest/functions.js) call
 * callInternal('/webhook/shopify-*'); registering those exact paths here lets
 * the invocations run in-process (no HTTP loopback, no port pressure), the same
 * pattern the other migrated crons use. The literal register() calls below are
 * also what tests/platform-hardening.test.js scans to assert every callInternal
 * path has a dispatcher handler.
 */

const internalDispatcher = require('../../lib/internalDispatcher');
const { buildShopifyWorkerHandlers } = require('./workers');

function registerShopifyDispatch({ apiRequest, sbGet, sbPost, sbPatch, sbDelete, logger }) {
  const handlers = buildShopifyWorkerHandlers({ apiRequest, sbGet, sbPost, sbPatch, sbDelete, logger });
  internalDispatcher.register('/webhook/shopify-initial-sync', (body) => handlers.initialSync(body));
  internalDispatcher.register('/webhook/shopify-ingest-resource', (body) => handlers.ingestResource(body));
  internalDispatcher.register('/webhook/shopify-purge-store', (body) => handlers.purgeStore(body));
  internalDispatcher.register('/webhook/shopify-redact-customer', (body) => handlers.redactCustomer(body));
}

module.exports = { registerShopifyDispatch };
