'use strict';

/**
 * services/oauth/meta.js
 * ----------------------------------------------------------------------------
 * Real Meta OAuth flow — captures the per-customer access_token + ad_account_id
 * + facebook_page_id + instagram_account_id + meta_pixel_id needed by
 * services/meta-marketing/index.js and services/meta-ad-library/index.js.
 *
 * OAuth flow (Authorization Code grant):
 *
 *   1. /webhook/oauth/meta/start?businessId=...
 *        Redirects user to Facebook login with the right scope set.
 *        State token contains the businessId (signed with N8N_WEBHOOK_SECRET).
 *
 *   2. /webhook/oauth/meta/callback?code=...&state=...
 *        Facebook redirects here. We:
 *          a) Exchange code → short-lived access_token (1h)
 *          b) Exchange short-lived → long-lived access_token (60d)
 *          c) Fetch the user's accessible ad accounts, pages, IG accounts
 *          d) Persist to businesses table
 *          e) Redirect to dashboard success page
 *
 *   3. /webhook/oauth/meta/refresh?businessId=...
 *        Meta long-lived tokens auto-renew on use — but if a customer
 *        revokes access, this endpoint surfaces it cleanly.
 *
 * Scopes requested (the minimal set we actually use):
 *   ads_management              — create + read campaigns
 *   ads_read                    — read insights
 *   pages_show_list             — list FB pages
 *   pages_manage_posts          — post to FB pages
 *   instagram_basic             — read IG account
 *   instagram_content_publish   — post to IG
 *   business_management         — read business assets
 *
 * Env required:
 *   META_APP_ID
 *   META_APP_SECRET
 *   META_OAUTH_REDIRECT_URI    (e.g. https://maroa-api-production.up.railway.app/webhook/oauth/meta/callback)
 *   FRONTEND_URL                (where to redirect after success/error,
 *                                e.g. https://maroa-ai-marketing-automator.lovable.app)
 *   N8N_WEBHOOK_SECRET          (used to sign state tokens)
 *
 * Public API:
 *   registerMetaOAuthRoutes({ app, sbGet, sbPatch, apiError, logger })
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const oauthCrypto = require('../../lib/oauthCrypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const META_GRAPH_VERSION = 'v21.0';
const META_GRAPH_HOST = 'graph.facebook.com';
const META_OAUTH_HOST = 'www.facebook.com';

const SCOPES = [
  'ads_management',
  'ads_read',
  'pages_show_list',
  'pages_manage_posts',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
  'read_insights',
].join(',');

// ─── State token (signed, prevents CSRF + tampering + account-takeover) ───
//
// State binds:
//   businessId   — the business the OAuth grant will be attached to
//   userId       — the Supabase auth user who initiated the flow
//   nonce        — 16-byte random, prevents replay
//   ts           — timestamp, 30-min expiry
//   sig          — HMAC of (businessId|userId|nonce|ts)
//
// At /start we verify the JWT user OWNS businessId before signing — so the
// state can't be forged for someone else's business. At /callback we just
// re-check the HMAC; if it matches, we know the same authenticated user
// initiated the flow, so token persistence is safe.

function signState({ businessId, userId, ts = Date.now(), nonce, secret }) {
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const payload = `${businessId}|${userId}|${n}|${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyState(stateB64, secret) {
  if (!stateB64) return null;
  let raw;
  try {
    raw = Buffer.from(stateB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split('|');
  if (parts.length !== 5) return null;
  const [businessId, userId, nonce, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${businessId}|${userId}|${nonce}|${ts}`).digest('hex');
  let ok = false;
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (!isUuid(businessId) || !isUuid(userId)) return null;
  if (Date.now() - Number(ts) > 30 * 60 * 1000) return null;
  return { businessId, userId, nonce, ts: Number(ts) };
}

// ─── Graph helper ─────────────────────────────────────────────────────────

async function graphCall({ method = 'GET', path, accessToken, query, body }) {
  const params = new URLSearchParams({ access_token: accessToken, ...(query || {}) });
  const url = `https://${META_GRAPH_HOST}/${META_GRAPH_VERSION}${path}?${params.toString()}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    return { ok: false, status: res.status, reason: json?.error?.message || `HTTP ${res.status}`, raw: json };
  }
  return { ok: true, raw: json };
}

// ─── OAuth steps ──────────────────────────────────────────────────────────

async function exchangeCodeForToken({ code, appId, appSecret, redirectUri }) {
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
  const url = `https://${META_GRAPH_HOST}/${META_GRAPH_VERSION}/oauth/access_token?${params.toString()}`;
  const res = await fetch(url, { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    return { ok: false, reason: json?.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true, access_token: json.access_token, expires_in: json.expires_in };
}

async function exchangeShortForLong({ shortToken, appId, appSecret }) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken,
  });
  const url = `https://${META_GRAPH_HOST}/${META_GRAPH_VERSION}/oauth/access_token?${params.toString()}`;
  const res = await fetch(url, { method: 'GET' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    return { ok: false, reason: json?.error?.message || `HTTP ${res.status}` };
  }
  // Long-lived tokens last ~60 days, can be auto-refreshed by Meta on use
  return { ok: true, access_token: json.access_token, expires_in: json.expires_in };
}

async function fetchAccessibleAssets({ accessToken }) {
  // Three parallel calls — ad accounts, pages, IG accounts
  const [adAccountsRes, pagesRes] = await Promise.all([
    graphCall({ path: '/me/adaccounts', accessToken, query: { fields: 'id,account_id,name,currency,timezone_name' } }),
    graphCall({
      path: '/me/accounts',
      accessToken,
      query: { fields: 'id,name,access_token,instagram_business_account{id,username}' },
    }),
  ]);

  const adAccounts = adAccountsRes.ok ? adAccountsRes.raw?.data || [] : [];
  const pages = pagesRes.ok ? pagesRes.raw?.data || [] : [];

  // First page that has an IG business account attached
  const pageWithIg = pages.find((p) => p.instagram_business_account?.id);
  const fallbackPage = pages[0];

  return {
    ad_accounts: adAccounts,
    pages,
    primary_ad_account: adAccounts[0] || null, // Customer can override later
    primary_page: pageWithIg || fallbackPage || null,
    instagram_business_account: pageWithIg?.instagram_business_account || null,
  };
}

// ─── Express routes ───────────────────────────────────────────────────────

function registerMetaOAuthRoutes({ app, sbGet, sbPatch, sbPost, apiError, logger, verifyUserJwt }) {
  const APP_ID = (process.env.META_APP_ID || '').trim();
  const APP_SECRET = (process.env.META_APP_SECRET || '').trim();
  const REDIRECT_URI = (
    process.env.META_OAUTH_REDIRECT_URI || 'https://maroa-api-production.up.railway.app/webhook/oauth/meta/callback'
  ).trim();
  const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://maroa-ai-marketing-automator.lovable.app').trim();
  const STATE_SECRET = (process.env.N8N_WEBHOOK_SECRET || '').trim();

  // Best-effort ownership check. Verifies the authenticated user is the
  // owner of `businessId` in the businesses table. Returns true/false.
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

  // Extract JWT from Authorization header OR ?token= query (browser redirects
  // can't set headers, so the token query-param is the only way to carry
  // a JWT through Facebook's auth dialog round-trip).
  function readBearer(req) {
    const h = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (h) return h[1].trim();
    if (typeof req.query?.token === 'string' && req.query.token.length > 20) return req.query.token.trim();
    return null;
  }

  // ─── /webhook/oauth/meta/start ────────────────────────────────────────
  // Customer clicks "Connect Meta" in the dashboard → frontend hits this with
  // their Supabase JWT → we verify they own businessId, then redirect to FB.
  app.get('/webhook/oauth/meta/start', async (req, res) => {
    const businessId = req.query.businessId || req.query.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    if (!isUuid(businessId)) return apiError(res, 400, 'INVALID_REQUEST', 'businessId must be a valid UUID');
    if (!APP_ID || !APP_SECRET) return apiError(res, 503, 'NOT_CONFIGURED', 'Meta OAuth not configured');
    if (!STATE_SECRET) return apiError(res, 503, 'NOT_CONFIGURED', 'N8N_WEBHOOK_SECRET required for state signing');
    if (typeof verifyUserJwt !== 'function') return apiError(res, 503, 'NOT_CONFIGURED', 'verifyUserJwt not wired');

    // Auth: require a Supabase JWT identifying the user initiating the flow.
    // Without this the attacker could call /start?businessId=<victim> and
    // bind their own Meta tokens to a victim's business row.
    const token = readBearer(req);
    if (!token) return apiError(res, 401, 'UNAUTHORIZED', 'Bearer token or ?token= required');

    const user = await verifyUserJwt(token).catch(() => null);
    if (!user?.id) return apiError(res, 401, 'UNAUTHORIZED', 'invalid JWT');

    // Ownership: the authenticated user must actually own businessId before
    // we issue a state token for them. Anything else is account-takeover.
    const owns = await userOwnsBusiness(user.id, businessId);
    if (!owns) {
      logger?.warn?.('/webhook/oauth/meta/start', businessId, 'auth user does not own business', { user_id: user.id });
      return apiError(res, 403, 'FORBIDDEN', 'authenticated user does not own this business');
    }

    const state = signState({ businessId, userId: user.id, secret: STATE_SECRET });
    const params = new URLSearchParams({
      client_id: APP_ID,
      redirect_uri: REDIRECT_URI,
      state,
      scope: SCOPES,
      response_type: 'code',
    });
    const authUrl = `https://${META_OAUTH_HOST}/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
    return res.redirect(302, authUrl);
  });

  // ─── /webhook/oauth/meta/callback ─────────────────────────────────────
  app.get('/webhook/oauth/meta/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger?.warn?.('/webhook/oauth/meta/callback', null, 'user cancelled or denied', { oauthError });
      return res.redirect(302, `${FRONTEND_URL}/integrations?meta=cancelled`);
    }
    if (!code) return apiError(res, 400, 'INVALID_REQUEST', 'code required');

    const verified = verifyState(state, STATE_SECRET);
    if (!verified) return apiError(res, 400, 'INVALID_STATE', 'state token invalid or expired');
    const businessId = verified.businessId;

    try {
      // 1. Code → short token
      const shortRes = await exchangeCodeForToken({
        code,
        appId: APP_ID,
        appSecret: APP_SECRET,
        redirectUri: REDIRECT_URI,
      });
      if (!shortRes.ok) {
        logger?.error?.('/webhook/oauth/meta/callback', businessId, 'short token exchange failed', {
          reason: shortRes.reason,
        });
        return res.redirect(
          302,
          `${FRONTEND_URL}/integrations?meta=error&reason=${encodeURIComponent(shortRes.reason)}`
        );
      }

      // 2. Short → long-lived (60 days)
      const longRes = await exchangeShortForLong({
        shortToken: shortRes.access_token,
        appId: APP_ID,
        appSecret: APP_SECRET,
      });
      if (!longRes.ok) {
        logger?.error?.('/webhook/oauth/meta/callback', businessId, 'long token exchange failed', {
          reason: longRes.reason,
        });
        return res.redirect(
          302,
          `${FRONTEND_URL}/integrations?meta=error&reason=${encodeURIComponent(longRes.reason)}`
        );
      }

      // 3. Fetch accessible ad accounts + pages + IG accounts
      const assets = await fetchAccessibleAssets({ accessToken: longRes.access_token });

      // 4. Persist to businesses row.
      //
      // Dual-write: encrypted column (preferred) + legacy plaintext column.
      // Once scripts/encrypt-oauth-tokens.js has backfilled all rows and
      // every consuming service reads via oauthCrypto.readToken(), migration
      // 060 will drop the plaintext columns. Until then, plaintext keeps
      // the existing read paths working.
      const patch = {
        meta_access_token: longRes.access_token, // legacy plaintext (dropped in 060)
        ...oauthCrypto.encryptIfEnabled('meta_access_token', longRes.access_token),
        meta_token_expires_at: longRes.expires_in
          ? new Date(Date.now() + longRes.expires_in * 1000).toISOString()
          : null,
        ad_account_id:
          assets.primary_ad_account?.account_id || assets.primary_ad_account?.id?.replace(/^act_/, '') || null,
        facebook_page_id: assets.primary_page?.id || null,
        facebook_page_access_token: assets.primary_page?.access_token || null,
        ...oauthCrypto.encryptIfEnabled('facebook_page_access_token', assets.primary_page?.access_token),
        instagram_account_id: assets.instagram_business_account?.id || null,
        meta_connected_at: new Date().toISOString(),
      };
      await sbPatch('businesses', `id=eq.${businessId}`, patch).catch((e) => {
        logger?.error?.('/webhook/oauth/meta/callback', businessId, 'sbPatch failed', { error: e.message });
      });

      // 5. Audit row for traceability
      await sbPost?.('onboarding_events', {
        business_id: businessId,
        event_type: 'meta_oauth_connected',
        event_data: {
          ad_accounts_count: assets.ad_accounts.length,
          pages_count: assets.pages.length,
          has_instagram: !!assets.instagram_business_account,
        },
      }).catch(() => {});

      return res.redirect(302, `${FRONTEND_URL}/integrations?meta=connected`);
    } catch (e) {
      logger?.error?.('/webhook/oauth/meta/callback', businessId, 'callback handler crashed', { error: e.message });
      return res.redirect(302, `${FRONTEND_URL}/integrations?meta=error&reason=${encodeURIComponent(e.message)}`);
    }
  });

  // ─── /webhook/oauth/meta/health (status probe for dashboard) ──────────
  app.get('/webhook/oauth/meta/health', async (req, res) => {
    const businessId = req.query.businessId || req.query.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const rows = await sbGet(
        'businesses',
        `id=eq.${businessId}&select=meta_access_token,meta_token_expires_at,ad_account_id,facebook_page_id,instagram_account_id,meta_connected_at`
      ).catch(() => []);
      const b = rows?.[0];
      if (!b?.meta_access_token) return res.json({ connected: false });

      // Verify with Meta — graph /me/permissions returns 401 if revoked
      const probe = await graphCall({
        path: '/me/permissions',
        accessToken: b.meta_access_token,
      });
      if (!probe.ok) {
        return res.json({
          connected: false,
          last_check: 'token_revoked_or_expired',
          token_status: 'invalid',
          reason: probe.reason,
        });
      }

      return res.json({
        connected: true,
        ad_account_id: b.ad_account_id,
        facebook_page_id: b.facebook_page_id,
        instagram_account_id: b.instagram_account_id,
        meta_connected_at: b.meta_connected_at,
        token_expires_at: b.meta_token_expires_at,
        granted_permissions: (probe.raw?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission),
      });
    } catch (e) {
      apiError(res, 500, 'META_OAUTH_HEALTH_FAILED', e.message);
    }
  });
}

module.exports = {
  registerMetaOAuthRoutes,
  signState,
  verifyState,
  SCOPES,
};
