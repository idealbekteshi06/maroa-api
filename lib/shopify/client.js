'use strict';

/**
 * lib/shopify/client.js — thin, per-store Shopify GraphQL Admin API client.
 *
 * Shopify public apps are PER-STORE: each call carries the store's own shop
 * domain + offline access token (decrypted from businesses.shopify_access_token_enc
 * at the call site). Nothing here is read from a global env credential.
 *
 * Resilience: every request goes through lib/externalHttp, which auto-routes by
 * hostname (`*.myshopify.com`) to the `shopify` circuit breaker + per-service
 * timeout (lib/breakers, lib/serviceTimeouts). On top of that, this client adds
 * Shopify-specific throttle handling: the GraphQL Admin API signals rate-limit
 * with an HTTP 200 whose body contains `errors[].extensions.code === 'THROTTLED'`
 * (a leaky-bucket cost model), which externalHttp's status-based retry can't see.
 * We detect THROTTLED and back off using the returned restore rate.
 *
 * REST is intentionally NOT supported — new public apps must use GraphQL only.
 *
 * Writes (the `write_products` scope) go through `mutate()`, which is gated by
 * the SHOPIFY_SYNC_LIVE flag: when off (the default) it logs the intended
 * mutation and returns a dry-run result without touching Shopify. Reads (`query`)
 * are never gated — pulling a store's own data into Maroa spends nothing and
 * posts nothing outward.
 */

const externalHttp = require('../externalHttp');
const { retryWithJitter } = require('../retryWithJitter');
const { isValidShopDomain } = require('./hmac');

const DEFAULT_API_VERSION = '2026-01';
const THROTTLE_MAX_RETRIES = 4;

function apiVersion() {
  // This is a pure lib invoked directly by unit tests, so it must NOT import the
  // env validator (env.parse() calls process.exit when required vars are missing,
  // which would kill the test process). These two reads are simple runtime
  // toggles, read lazily — the documented exception to CLAUDE.md Rule 1.
  // eslint-disable-next-line no-restricted-syntax
  return (process.env.SHOPIFY_API_VERSION || '').trim() || DEFAULT_API_VERSION;
}

function graphqlEndpoint(shop) {
  return `https://${shop}/admin/api/${apiVersion()}/graphql.json`;
}

function syncIsLive() {
  // eslint-disable-next-line no-restricted-syntax
  return String(process.env.SHOPIFY_SYNC_LIVE || '').toLowerCase() === 'true';
}

class ShopifyGraphQLError extends Error {
  constructor(message, { status, errors, userErrors } = {}) {
    super(message);
    this.name = 'ShopifyGraphQLError';
    this.status = status;
    this.errors = errors || null;
    this.userErrors = userErrors || null;
  }
}

function isThrottled(body) {
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  return errors.some((e) => e?.extensions?.code === 'THROTTLED');
}

// Shopify returns the leaky-bucket state on every response. Wait long enough to
// refill the requested cost, capped so a pathological value can't stall a job.
function throttleDelayMs(body) {
  const ts = body?.extensions?.cost?.throttleStatus;
  const requested = body?.extensions?.cost?.requestedQueryCost;
  if (ts && Number.isFinite(ts.restoreRate) && ts.restoreRate > 0 && Number.isFinite(requested)) {
    const deficit = Math.max(0, requested - (ts.currentlyAvailable || 0));
    const seconds = deficit / ts.restoreRate;
    return Math.min(10_000, Math.max(500, Math.ceil(seconds * 1000)));
  }
  return 1_000;
}

/**
 * Execute a GraphQL operation against a single store's Admin API.
 *
 * @param {Function} apiRequest             Low-level HTTP helper (server.js apiRequest).
 * @param {object}   opts
 * @param {string}   opts.shop              `<store>.myshopify.com`.
 * @param {string}   opts.accessToken       Decrypted offline access token.
 * @param {string}   opts.query             GraphQL document.
 * @param {object}   [opts.variables]       GraphQL variables.
 * @param {object}   [opts.logger]
 * @returns {Promise<object>}               The GraphQL `data` object.
 */
async function shopifyGraphQL(apiRequest, { shop, accessToken, query, variables = {}, logger } = {}) {
  if (typeof apiRequest !== 'function') throw new TypeError('shopifyGraphQL: apiRequest must be a function');
  if (!isValidShopDomain(shop)) throw new ShopifyGraphQLError('invalid shop domain');
  if (!accessToken) throw new ShopifyGraphQLError('missing access token');
  if (!query) throw new ShopifyGraphQLError('missing query');

  const url = graphqlEndpoint(shop);
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken };

  let attempt = 0;
  // The breaker + transport retry live in externalHttp; this loop only handles
  // GraphQL-level THROTTLED (HTTP 200 + errors), which externalHttp can't see.
  return retryWithJitter(
    async () => {
      const resp = await externalHttp(apiRequest, 'POST', url, headers, { query, variables });
      if (resp.status === 401 || resp.status === 403) {
        throw new ShopifyGraphQLError(`shopify auth failed (${resp.status})`, { status: resp.status });
      }
      if (resp.status !== 200) {
        throw new ShopifyGraphQLError(`shopify graphql http ${resp.status}`, { status: resp.status });
      }
      const body = resp.body || {};
      if (isThrottled(body)) {
        attempt += 1;
        if (attempt > THROTTLE_MAX_RETRIES) {
          throw new ShopifyGraphQLError('shopify throttled (max retries)', { status: 429, errors: body.errors });
        }
        const wait = throttleDelayMs(body);
        logger?.warn?.('/shopify', null, 'graphql throttled — backing off', { shop, attempt, wait_ms: wait });
        await new Promise((r) => setTimeout(r, wait));
        const err = new Error('shopify_throttled');
        err._retryThrottle = true;
        throw err;
      }
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new ShopifyGraphQLError('shopify graphql errors', { status: 200, errors: body.errors });
      }
      return body.data || null;
    },
    {
      retries: THROTTLE_MAX_RETRIES,
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      // Only our explicit throttle marker retries here; real errors propagate.
      isRetryable: (e) => e?._retryThrottle === true,
    }
  );
}

/**
 * Execute a write/mutation. Gated by SHOPIFY_SYNC_LIVE (default OFF = dry-run).
 * Returns `{ dryRun: true, skipped: true }` without calling Shopify when off.
 */
async function shopifyMutate(apiRequest, { shop, accessToken, query, variables = {}, logger } = {}) {
  if (!syncIsLive()) {
    logger?.info?.('/shopify', null, 'mutation suppressed — SHOPIFY_SYNC_LIVE not enabled (dry-run)', { shop });
    return { dryRun: true, skipped: true };
  }
  const data = await shopifyGraphQL(apiRequest, { shop, accessToken, query, variables, logger });
  return { dryRun: false, data };
}

module.exports = {
  shopifyGraphQL,
  shopifyMutate,
  graphqlEndpoint,
  apiVersion,
  syncIsLive,
  ShopifyGraphQLError,
  DEFAULT_API_VERSION,
};
