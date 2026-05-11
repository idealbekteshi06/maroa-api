'use strict';

/**
 * services/oauth/google.js
 * ----------------------------------------------------------------------------
 * Real Google OAuth flow — captures the per-customer refresh_token +
 * google_customer_id needed by services/google-ads-api/index.js.
 *
 * Why refresh_token (not access_token like Meta): Google access tokens
 * expire after 1 hour. The refresh_token can be exchanged for fresh
 * access tokens indefinitely, so we store the refresh_token and let
 * services/google-ads-api/index.js mint short-lived access tokens on
 * each API call.
 *
 * Scopes:
 *   adwords         — Google Ads API access
 *   userinfo.email  — identify the user
 *   userinfo.profile — display name + photo for the dashboard
 *
 * Critical OAuth params:
 *   access_type=offline       — REQUIRED to get a refresh_token
 *   prompt=consent            — force re-prompt so we always get a refresh_token
 *                               (Google only returns it once per consent;
 *                                without prompt=consent, repeat connects
 *                                fail silently)
 *
 * Env required:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI
 *   FRONTEND_URL
 *   N8N_WEBHOOK_SECRET
 *
 * Public API:
 *   registerGoogleOAuthRoutes({ app, sbGet, sbPatch, apiError, logger })
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const oauthCrypto = require('../../lib/oauthCrypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const GOOGLE_AUTH_HOST = 'accounts.google.com';
const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
const GOOGLE_USERINFO_HOST = 'www.googleapis.com';
const GOOGLE_ADS_HOST = 'googleads.googleapis.com';
const GOOGLE_ADS_VERSION = 'v18';

const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// ─── State token (binds businessId + userId + nonce + ts) ─────────────────
// See services/oauth/meta.js for full rationale — both flows share the same
// HMAC scheme so the security properties are identical.

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

// ─── Token exchange ───────────────────────────────────────────────────────

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(`https://${GOOGLE_TOKEN_HOST}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: json?.error_description || json?.error || `HTTP ${res.status}` };
  // refresh_token is only returned on first consent (or when prompt=consent)
  return {
    ok: true,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    id_token: json.id_token,
  };
}

async function fetchUserInfo({ accessToken }) {
  const res = await fetch(`https://${GOOGLE_USERINFO_HOST}/oauth2/v3/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function listAccessibleAdsCustomers({ accessToken }) {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) return [];
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  }
  try {
    const res = await fetch(`https://${GOOGLE_ADS_HOST}/${GOOGLE_ADS_VERSION}/customers:listAccessibleCustomers`, {
      method: 'GET',
      headers,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    // Returns resourceNames like 'customers/1234567890'
    return (json.resourceNames || []).map((rn) => rn.replace(/^customers\//, ''));
  } catch {
    return [];
  }
}

// ─── Express routes ───────────────────────────────────────────────────────

function registerGoogleOAuthRoutes({ app, sbGet, sbPatch, sbPost, apiError, logger, verifyUserJwt }) {
  const CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const REDIRECT_URI = (
    process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://maroa-api-production.up.railway.app/webhook/oauth/google/callback'
  ).trim();
  const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://maroa-ai-marketing-automator.lovable.app').trim();
  const STATE_SECRET = (process.env.N8N_WEBHOOK_SECRET || '').trim();

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
  function readBearer(req) {
    const h = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (h) return h[1].trim();
    if (typeof req.query?.token === 'string' && req.query.token.length > 20) return req.query.token.trim();
    return null;
  }

  app.get('/webhook/oauth/google/start', async (req, res) => {
    const businessId = req.query.businessId || req.query.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    if (!isUuid(businessId)) return apiError(res, 400, 'INVALID_REQUEST', 'businessId must be a valid UUID');
    if (!CLIENT_ID || !CLIENT_SECRET) return apiError(res, 503, 'NOT_CONFIGURED', 'Google OAuth not configured');
    if (!STATE_SECRET) return apiError(res, 503, 'NOT_CONFIGURED', 'N8N_WEBHOOK_SECRET required');
    if (typeof verifyUserJwt !== 'function') return apiError(res, 503, 'NOT_CONFIGURED', 'verifyUserJwt not wired');

    // Same account-takeover prevention as Meta — JWT identifies the caller,
    // ownership check binds the resulting refresh_token to the right business.
    const token = readBearer(req);
    if (!token) return apiError(res, 401, 'UNAUTHORIZED', 'Bearer token or ?token= required');
    const user = await verifyUserJwt(token).catch(() => null);
    if (!user?.id) return apiError(res, 401, 'UNAUTHORIZED', 'invalid JWT');
    const owns = await userOwnsBusiness(user.id, businessId);
    if (!owns) {
      logger?.warn?.('/webhook/oauth/google/start', businessId, 'auth user does not own business', {
        user_id: user.id,
      });
      return apiError(res, 403, 'FORBIDDEN', 'authenticated user does not own this business');
    }

    const state = signState({ businessId, userId: user.id, secret: STATE_SECRET });
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
      scope: SCOPES,
      response_type: 'code',
      access_type: 'offline', // REQUIRED for refresh_token
      prompt: 'consent', // REQUIRED to re-issue refresh_token on reconnect
      include_granted_scopes: 'true',
    });
    return res.redirect(302, `https://${GOOGLE_AUTH_HOST}/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get('/webhook/oauth/google/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      logger?.warn?.('/webhook/oauth/google/callback', null, 'user denied', { oauthError });
      return res.redirect(302, `${FRONTEND_URL}/integrations?google=cancelled`);
    }
    if (!code) return apiError(res, 400, 'INVALID_REQUEST', 'code required');

    const verified = verifyState(state, STATE_SECRET);
    if (!verified) return apiError(res, 400, 'INVALID_STATE', 'state token invalid or expired');
    const businessId = verified.businessId;

    try {
      const tokenRes = await exchangeCode({
        code,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      if (!tokenRes.ok) {
        return res.redirect(
          302,
          `${FRONTEND_URL}/integrations?google=error&reason=${encodeURIComponent(tokenRes.reason)}`
        );
      }
      if (!tokenRes.refresh_token) {
        // This means the user has already granted before AND we didn't pass prompt=consent
        // (we do pass it, but defensive — could fail if user revoked at Google side first)
        return res.redirect(
          302,
          `${FRONTEND_URL}/integrations?google=error&reason=${encodeURIComponent('No refresh_token returned. Please disconnect at myaccount.google.com/permissions and retry.')}`
        );
      }

      // Identify the user (for display + audit)
      const userInfo = await fetchUserInfo({ accessToken: tokenRes.access_token });

      // List accessible Ads customers (the customer IDs they manage)
      const accessibleCustomers = await listAccessibleAdsCustomers({ accessToken: tokenRes.access_token });
      const primaryCustomerId = accessibleCustomers[0] || null;

      // Dual-write: encrypted column (preferred) + legacy plaintext.
      // See migration 056 and lib/oauthCrypto.js for the encryption scheme.
      const patch = {
        google_refresh_token: tokenRes.refresh_token, // legacy plaintext (dropped in 060)
        ...oauthCrypto.encryptIfEnabled('google_refresh_token', tokenRes.refresh_token),
        google_customer_id: primaryCustomerId,
        google_oauth_email: userInfo?.email || null,
        google_connected_at: new Date().toISOString(),
      };
      await sbPatch('businesses', `id=eq.${businessId}`, patch).catch((e) => {
        logger?.error?.('/webhook/oauth/google/callback', businessId, 'sbPatch failed', { error: e.message });
      });

      await sbPost?.('onboarding_events', {
        business_id: businessId,
        event_type: 'google_oauth_connected',
        event_data: {
          accessible_customers_count: accessibleCustomers.length,
          primary_customer_id: primaryCustomerId,
          email: userInfo?.email,
        },
      }).catch(() => {});

      return res.redirect(302, `${FRONTEND_URL}/integrations?google=connected`);
    } catch (e) {
      logger?.error?.('/webhook/oauth/google/callback', businessId, 'callback crashed', { error: e.message });
      return res.redirect(302, `${FRONTEND_URL}/integrations?google=error&reason=${encodeURIComponent(e.message)}`);
    }
  });

  // SECURITY: same fix as Meta /health — requires JWT + ownership.
  // Without it, anyone with a UUID could extract google_customer_id +
  // google_oauth_email for any customer.
  app.get('/webhook/oauth/google/health', async (req, res) => {
    const businessId = req.query.businessId || req.query.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    if (!isUuid(businessId)) return apiError(res, 400, 'INVALID_REQUEST', 'businessId must be a valid UUID');
    if (typeof verifyUserJwt !== 'function') return apiError(res, 503, 'NOT_CONFIGURED', 'verifyUserJwt not wired');

    const token = readBearer(req);
    if (!token) return apiError(res, 401, 'UNAUTHORIZED', 'Bearer token or ?token= required');
    const user = await verifyUserJwt(token).catch(() => null);
    if (!user?.id) return apiError(res, 401, 'UNAUTHORIZED', 'invalid JWT');
    const owns = await userOwnsBusiness(user.id, businessId);
    if (!owns) {
      logger?.warn?.('/webhook/oauth/google/health', businessId, 'auth user does not own business', {
        user_id: user.id,
      });
      return apiError(res, 403, 'FORBIDDEN', 'authenticated user does not own this business');
    }

    try {
      // SELECT both legacy AND encrypted columns so oauthCrypto.readToken
      // can prefer the encrypted value. Migration 060 will drop the
      // legacy column; this query already works for both states.
      // (Same fix the Antigravity review proposed for Meta /health.)
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=google_refresh_token,google_refresh_token_enc,google_customer_id,google_oauth_email,google_connected_at`
      ).catch(() => []);
      const b = rows?.[0];
      const tokenToUse = oauthCrypto.readToken(b, 'google_refresh_token');
      if (!tokenToUse) return res.json({ connected: false });

      return res.json({
        connected: true,
        customer_id: b.google_customer_id,
        oauth_email: b.google_oauth_email,
        connected_at: b.google_connected_at,
      });
    } catch (e) {
      apiError(res, 500, 'GOOGLE_OAUTH_HEALTH_FAILED', e.message);
    }
  });
}

module.exports = {
  registerGoogleOAuthRoutes,
  signState,
  verifyState,
  SCOPES,
};
