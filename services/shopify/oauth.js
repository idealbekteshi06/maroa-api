'use strict';

/**
 * services/shopify/oauth.js — Shopify public-app OAuth (dashboard-initiated).
 *
 * Mirrors services/oauth/meta.js exactly:
 *   GET /auth/shopify/install   — merchant clicks "Connect Shopify" in the
 *     logged-in dashboard. We verify their Supabase JWT owns `businessId`, sign
 *     CSRF state (businessId|platform|userId|nonce|ts|hmac via lib/oauthState),
 *     and 302 to Shopify's consent screen requesting the minimal scopes.
 *   GET /auth/shopify/callback  — Shopify redirects back. We verify BOTH the
 *     Shopify query HMAC (proves the redirect is from Shopify) AND our signed
 *     state (proves the same authenticated user started it), exchange the code
 *     for an OFFLINE access token, store it ENCRYPTED on the businesses row, and
 *     enqueue install sync (webhook registration + backfill) via Inngest.
 *
 * Offline tokens don't expire and have no refresh token, so there's no expiry
 * column and no refresh cron. The token is stored encrypted-only (no plaintext
 * twin); we refuse to complete the flow if OAUTH_TOKEN_ENC_KEY is unset rather
 * than silently storing nothing.
 *
 * Env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_OAUTH_REDIRECT_URI,
 *      SHOPIFY_SCOPES (optional), FRONTEND_URL, N8N_WEBHOOK_SECRET (state).
 */

const oauthCrypto = require('../../lib/oauthCrypto');
const { signOAuthState, verifyOAuthState, isUuid } = require('../../lib/oauthState');
const { verifyQueryHmac, isValidShopDomain } = require('../../lib/shopify/hmac');

const PLATFORM = 'shopify';
const DEFAULT_SCOPES = 'read_orders,read_products,write_products,read_customers';

// Read from the validated env object (Rule 1), not process.env. Lazy + cached:
// only the server path calls this (tests inject an explicit config), so env
// validation never runs at import time.
function loadConfig() {
  const env = require('../../lib/env').parse();
  return {
    API_KEY: env.SHOPIFY_API_KEY || '',
    API_SECRET: env.SHOPIFY_API_SECRET || '',
    REDIRECT_URI: env.SHOPIFY_OAUTH_REDIRECT_URI || 'https://maroa-api-production.up.railway.app/auth/shopify/callback',
    FRONTEND_URL: env.FRONTEND_URL || 'https://maroa-ai-marketing-automator.lovable.app',
    STATE_SECRET: env.N8N_WEBHOOK_SECRET || '',
    SCOPES: env.SHOPIFY_SCOPES || DEFAULT_SCOPES,
  };
}

function readBearer(req) {
  const h = (req.get?.('authorization') || req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (h) return h[1].trim();
  if (typeof req.query?.token === 'string' && req.query.token.length > 20) return req.query.token.trim();
  return null;
}

async function exchangeCodeForToken({ shop, code, apiKey, apiSecret, fetchImpl }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    return { ok: false, reason: json?.error_description || json?.error || `HTTP ${res.status}` };
  }
  return { ok: true, access_token: json.access_token, scope: json.scope || '' };
}

/**
 * Build the install/callback handlers with injected deps. Exported so tests can
 * drive them with fake req/res without standing up an HTTP server.
 */
function buildShopifyOAuthHandlers({
  sbGet,
  sbPatch,
  sbPost,
  apiError,
  logger,
  verifyUserJwt,
  inngest,
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
}) {
  async function userOwnsBusiness(userId, businessId) {
    if (!isUuid(userId) || !isUuid(businessId)) return false;
    try {
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`
      );
      return Array.isArray(rows) && rows.length === 1;
    } catch {
      return false;
    }
  }

  async function install(req, res) {
    const shop = req.query.shop;
    const businessId = req.query.businessId || req.query.business_id;
    if (!isValidShopDomain(shop))
      return apiError(res, 400, 'INVALID_REQUEST', 'valid ?shop=<store>.myshopify.com required');
    if (!isUuid(businessId)) return apiError(res, 400, 'INVALID_REQUEST', 'businessId must be a valid UUID');
    if (!config.API_KEY || !config.API_SECRET)
      return apiError(res, 503, 'NOT_CONFIGURED', 'Shopify OAuth not configured');
    if (!config.STATE_SECRET)
      return apiError(res, 503, 'NOT_CONFIGURED', 'N8N_WEBHOOK_SECRET required for state signing');
    if (typeof verifyUserJwt !== 'function') return apiError(res, 503, 'NOT_CONFIGURED', 'verifyUserJwt not wired');

    const token = readBearer(req);
    if (!token) return apiError(res, 401, 'UNAUTHORIZED', 'Bearer token or ?token= required');
    const user = await verifyUserJwt(token).catch(() => null);
    if (!user?.id) return apiError(res, 401, 'UNAUTHORIZED', 'invalid JWT');

    const owns = await userOwnsBusiness(user.id, businessId);
    if (!owns) {
      logger?.warn?.('/auth/shopify/install', businessId, 'auth user does not own business', { user_id: user.id });
      return apiError(res, 403, 'FORBIDDEN', 'authenticated user does not own this business');
    }

    const state = signOAuthState({ businessId, platform: PLATFORM, userId: user.id, secret: config.STATE_SECRET });
    const params = new URLSearchParams({
      client_id: config.API_KEY,
      scope: config.SCOPES,
      redirect_uri: config.REDIRECT_URI,
      state,
      // grant_options[] omitted ⇒ offline (permanent) access token.
    });
    return res.redirect(302, `https://${shop}/admin/oauth/authorize?${params.toString()}`);
  }

  async function callback(req, res) {
    const { shop, code, state } = req.query;
    const fail = (reason) =>
      res.redirect(
        302,
        `${config.FRONTEND_URL}/settings/connections?shopify=error&reason=${encodeURIComponent(reason)}`
      );

    if (!code) return apiError(res, 400, 'INVALID_REQUEST', 'code required');
    if (!isValidShopDomain(shop)) return apiError(res, 400, 'INVALID_REQUEST', 'invalid shop');
    if (!config.API_SECRET) return apiError(res, 503, 'NOT_CONFIGURED', 'Shopify OAuth not configured');

    // 1. Prove the redirect genuinely came from Shopify (query HMAC).
    if (!verifyQueryHmac(req.query, config.API_SECRET)) {
      logger?.warn?.('/auth/shopify/callback', null, 'shopify query HMAC verification failed', { shop });
      return apiError(res, 400, 'INVALID_HMAC', 'Shopify HMAC verification failed');
    }
    // 2. Prove the same authenticated user started the flow (signed state).
    const verified = verifyOAuthState(state, config.STATE_SECRET, { platform: PLATFORM });
    if (!verified) return apiError(res, 400, 'INVALID_STATE', 'state token invalid or expired');
    const businessId = verified.businessId;

    // 3. Encryption MUST be enabled — never store the token in plaintext or
    //    silently drop it. Fail loud so the operator sets OAUTH_TOKEN_ENC_KEY.
    if (!oauthCrypto.isEnabled()) {
      logger?.error?.('/auth/shopify/callback', businessId, 'OAUTH_TOKEN_ENC_KEY not set — refusing to store token');
      return apiError(res, 503, 'ENCRYPTION_DISABLED', 'token encryption not configured');
    }

    try {
      const tok = await exchangeCodeForToken({
        shop,
        code,
        apiKey: config.API_KEY,
        apiSecret: config.API_SECRET,
        fetchImpl,
      });
      if (!tok.ok) {
        logger?.error?.('/auth/shopify/callback', businessId, 'token exchange failed', { reason: tok.reason });
        return fail(tok.reason);
      }

      const patch = {
        shopify_shop_domain: shop,
        ...oauthCrypto.encryptIfEnabled('shopify_access_token', tok.access_token),
        shopify_scopes: tok.scope || config.SCOPES,
        shopify_connected: true,
        shopify_connected_at: new Date().toISOString(),
        shopify_uninstalled_at: null,
      };
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, patch);

      await sbPost?.('onboarding_events', {
        business_id: businessId,
        event_type: 'shopify_oauth_connected',
        event_data: { shop, scopes: tok.scope || config.SCOPES },
      }).catch(() => {});

      // Durable install work (webhook registration + product/order backfill).
      if (inngest?.send) {
        await inngest
          .send({ name: 'maroa/shopify.install.sync', data: { businessId } })
          .catch((e) =>
            logger?.warn?.('/auth/shopify/callback', businessId, 'inngest enqueue failed', { error: e.message })
          );
      }

      return res.redirect(302, `${config.FRONTEND_URL}/settings/connections?shopify=connected`);
    } catch (e) {
      logger?.error?.('/auth/shopify/callback', businessId, 'callback crashed', { error: e.message });
      return fail(e.message);
    }
  }

  return { install, callback };
}

function registerShopifyOAuthRoutes(deps) {
  const { app } = deps;
  const handlers = buildShopifyOAuthHandlers(deps);
  app.get('/auth/shopify/install', handlers.install);
  app.get('/auth/shopify/callback', handlers.callback);
}

module.exports = {
  registerShopifyOAuthRoutes,
  buildShopifyOAuthHandlers,
  exchangeCodeForToken,
  loadConfig,
  DEFAULT_SCOPES,
  PLATFORM,
};
