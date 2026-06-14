'use strict';

/**
 * services/oauth/tokenRefresh.js — proactive OAuth token refresh.
 * ---------------------------------------------------------------------------
 * Rebuild of the lost launch/wiring-pass feature #2.
 *
 * LinkedIn (~60d), Twitter/X (~2h) and TikTok (~24h) access tokens expire and,
 * with no refresh, publishing silently 401s and the connection "dies." This
 * module refreshes them BEFORE expiry. The Inngest cron
 * `oauth-token-refresh-hourly` (services/inngest/functions.js) calls
 * /webhook/oauth-token-refresh-all every hour; each connected account whose
 * token is within the lead window (default 120 min, or whose expiry is
 * unknown) is refreshed.
 *
 * Google (refreshes on-demand in services/google-ads-api) and Meta (long-lived
 * auto-renewing tokens) are intentionally NOT handled here.
 *
 * Schema-tolerant + safe:
 *   - reads refresh tokens via oauthCrypto.readToken (prefers *_enc)
 *   - persists rotated tokens via oauthCrypto.encryptIfEnabled (providers issue
 *     a NEW refresh token on each refresh — we store it)
 *   - skips (never throws) on: not connected, no refresh token, missing client
 *     creds, provider error. One account's failure never blocks the others.
 * ---------------------------------------------------------------------------
 */

const oauthCrypto = require('../../lib/oauthCrypto');

const DEFAULT_LEAD_MINUTES = Number(process.env.OAUTH_REFRESH_LEAD_MINUTES || 120);

// Per-provider wiring. Client creds are read at call time (env rotation + tests).
const PROVIDERS = {
  linkedin: {
    connectedCol: 'linkedin_connected',
    accessCol: 'linkedin_access_token',
    refreshCol: 'linkedin_refresh_token',
    expiresCol: 'linkedin_token_expires_at',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    creds: () => ({ id: process.env.LINKEDIN_CLIENT_ID, secret: process.env.LINKEDIN_CLIENT_SECRET }),
    request: (refresh, { id, secret }) => ({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: id,
        client_secret: secret,
      }).toString(),
    }),
    parse: (j) => ({ access: j.access_token, refresh: j.refresh_token, expiresIn: j.expires_in }),
  },

  twitter: {
    connectedCol: 'twitter_connected',
    accessCol: 'twitter_access_token',
    refreshCol: 'twitter_refresh_token',
    expiresCol: 'twitter_token_expires_at',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    creds: () => ({ id: process.env.TWITTER_CLIENT_ID, secret: process.env.TWITTER_CLIENT_SECRET }),
    request: (refresh, { id, secret }) => ({
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: id,
      }).toString(),
    }),
    parse: (j) => ({ access: j.access_token, refresh: j.refresh_token, expiresIn: j.expires_in }),
  },

  tiktok: {
    connectedCol: 'tiktok_connected',
    accessCol: 'tiktok_access_token',
    refreshCol: 'tiktok_refresh_token',
    expiresCol: 'tiktok_token_expires_at',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    creds: () => ({ id: process.env.TIKTOK_CLIENT_KEY, secret: process.env.TIKTOK_CLIENT_SECRET }),
    request: (refresh, { id, secret }) => ({
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: id,
        client_secret: secret,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }).toString(),
    }),
    // TikTok nests the token fields under `data`.
    parse: (j) => {
      const d = j && j.data ? j.data : j || {};
      return { access: d.access_token, refresh: d.refresh_token, expiresIn: d.expires_in };
    },
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

/**
 * Is `provider` due for refresh on this business row?
 *   - not connected / no refresh token → false (nothing to do)
 *   - unknown expiry (NULL/unparseable) → true (refresh proactively; also
 *     populates expires_at so future runs are precise)
 *   - expiry within the lead window → true
 */
function isDue(business, provider, leadMinutes = DEFAULT_LEAD_MINUTES, now = Date.now()) {
  const cfg = PROVIDERS[provider];
  if (!cfg || !business) return false;
  if (business[cfg.connectedCol] !== true) return false;
  if (!oauthCrypto.readToken(business, cfg.refreshCol)) return false;
  const exp = business[cfg.expiresCol];
  if (!exp) return true;
  const expMs = new Date(exp).getTime();
  if (Number.isNaN(expMs)) return true;
  return expMs - now <= leadMinutes * 60 * 1000;
}

/** Refresh a single provider for one business. Never throws. */
async function refreshOne({ business, provider, deps }) {
  const { sbPatch, logger } = deps;
  const doFetch = deps.fetchImpl || fetch;
  const cfg = PROVIDERS[provider];
  if (!cfg) return { provider, ok: false, reason: 'unknown_provider' };

  const refreshToken = oauthCrypto.readToken(business, cfg.refreshCol);
  if (!refreshToken) return { provider, ok: false, skipped: true, reason: 'no_refresh_token' };

  const { id, secret } = cfg.creds();
  if (!id || !secret) return { provider, ok: false, skipped: true, reason: 'not_configured' };

  let json;
  try {
    const { headers, body } = cfg.request(refreshToken, { id, secret });
    const res = await doFetch(cfg.tokenUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
    json = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger?.warn?.('oauth-token-refresh', business.id, `${provider} HTTP ${res.status}`, {
        error: json?.error || json?.error_description || null,
      });
      return { provider, ok: false, status: res.status };
    }
  } catch (e) {
    logger?.warn?.('oauth-token-refresh', business?.id, `${provider} threw`, { error: e.message });
    return { provider, ok: false, reason: e.message };
  }

  const { access, refresh, expiresIn } = cfg.parse(json);
  if (!access) {
    logger?.warn?.('oauth-token-refresh', business?.id, `${provider} returned no access_token`);
    return { provider, ok: false, reason: 'no_access_token' };
  }

  const patch = {
    ...oauthCrypto.encryptIfEnabled(cfg.accessCol, access),
    // Providers rotate the refresh token on each refresh — persist the new one.
    ...(refresh ? oauthCrypto.encryptIfEnabled(cfg.refreshCol, refresh) : {}),
    [cfg.expiresCol]: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null,
  };

  try {
    await sbPatch('businesses', `id=eq.${encodeURIComponent(business.id)}`, patch);
  } catch (e) {
    logger?.warn?.('oauth-token-refresh', business?.id, `${provider} persist failed`, { error: e.message });
    return { provider, ok: false, reason: 'persist_failed' };
  }
  return { provider, ok: true, businessId: business.id, expiresIn: expiresIn || null };
}

/** Refresh every due provider for one business row. */
async function refreshBusiness({ business, deps, leadMinutes = DEFAULT_LEAD_MINUTES }) {
  const results = [];
  for (const provider of PROVIDER_NAMES) {
    if (!isDue(business, provider, leadMinutes)) continue;
    results.push(await refreshOne({ business, provider, deps }));
  }
  return results;
}

/** Cron entry point — refresh all due tokens across all connected businesses. */
async function refreshAllDue({ deps, leadMinutes = DEFAULT_LEAD_MINUTES }) {
  const { sbGet, logger } = deps;
  // Prefer a narrow filter; fall back to a broad scan if the drifted schema
  // rejects the `or=` (missing column) — isDue then filters in JS safely.
  let businesses = await sbGet(
    'businesses',
    'or=(linkedin_connected.eq.true,twitter_connected.eq.true,tiktok_connected.eq.true)&select=*&limit=5000'
  ).catch(() => null);
  if (!Array.isArray(businesses)) {
    businesses = await sbGet('businesses', 'select=*&limit=5000').catch(() => []);
  }

  let refreshed = 0;
  let failed = 0;
  let due = 0;
  for (const business of businesses || []) {
    for (const provider of PROVIDER_NAMES) {
      if (!isDue(business, provider, leadMinutes)) continue;
      due += 1;
      const r = await refreshOne({ business, provider, deps }).catch((e) => ({ ok: false, reason: e.message }));
      if (r?.ok) refreshed += 1;
      else if (!r?.skipped) failed += 1;
    }
  }
  logger?.info?.('oauth-token-refresh', null, 'refresh-all complete', {
    businesses: (businesses || []).length,
    due,
    refreshed,
    failed,
  });
  return { ok: true, businesses: (businesses || []).length, due, refreshed, failed };
}

module.exports = {
  PROVIDERS,
  PROVIDER_NAMES,
  DEFAULT_LEAD_MINUTES,
  isDue,
  refreshOne,
  refreshBusiness,
  refreshAllDue,
};
