/*
 * services/token-refresh/index.js
 * ----------------------------------------------------------------------------
 * OAuth token refresh for LinkedIn / Twitter / TikTok.
 *
 * These three flows stored a refresh token at connect time and then NEVER used
 * it — access tokens silently rotted (Twitter ~2h, TikTok ~24h, LinkedIn ~60d)
 * and the customer's "connected" platform died without any signal. Fatal for
 * a connect-and-forget product.
 *
 *   refreshPlatform()  — one business × one platform. Uses the stored refresh
 *                        token; persists the new access token (and the ROTATED
 *                        refresh token — Twitter and TikTok invalidate the old
 *                        one on every refresh). On a definitive rejection
 *                        (invalid_grant / 400 / 401) flips
 *                        `<platform>_connected = false` and writes an
 *                        `oauth.reconnect_required` event so integrations
 *                        health surfaces "reconnect needed". Transient errors
 *                        (5xx / network) change nothing — the next sweep
 *                        retries.
 *   sweepAll()         — every business with any of the three connected.
 *                        Driven by the daily `oauth-token-refresh-daily`
 *                        Inngest cron via /webhook/oauth-token-refresh.
 *
 * Twitter's 2-hour expiry also needs refresh-at-use: the WF1 publisher calls
 * refreshPlatform() on a 401 and retries once (see services/wf1/publish.js).
 * ----------------------------------------------------------------------------
 */

'use strict';

const oauthCrypto = require('../../lib/oauthCrypto');

const PLATFORMS = {
  linkedin: {
    connectedCol: 'linkedin_connected',
    accessName: 'linkedin_access_token',
    refreshName: 'linkedin_refresh_token',
    buildRequest(refreshToken, env) {
      if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) return null;
      return {
        url: 'https://www.linkedin.com/oauth/v2/accessToken',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }).toString(),
      };
    },
    parse(body) {
      return { accessToken: body?.access_token || null, refreshToken: body?.refresh_token || null };
    },
  },
  twitter: {
    connectedCol: 'twitter_connected',
    accessName: 'twitter_access_token',
    refreshName: 'twitter_refresh_token',
    buildRequest(refreshToken, env) {
      if (!env.TWITTER_CLIENT_ID || !env.TWITTER_CLIENT_SECRET) return null;
      const basicAuth = Buffer.from(`${env.TWITTER_CLIENT_ID}:${env.TWITTER_CLIENT_SECRET}`).toString('base64');
      return {
        url: 'https://api.twitter.com/2/oauth2/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: env.TWITTER_CLIENT_ID,
        }).toString(),
      };
    },
    parse(body) {
      return { accessToken: body?.access_token || null, refreshToken: body?.refresh_token || null };
    },
  },
  tiktok: {
    connectedCol: 'tiktok_connected',
    accessName: 'tiktok_access_token',
    refreshName: 'tiktok_refresh_token',
    buildRequest(refreshToken, env) {
      if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return null;
      return {
        url: 'https://open.tiktokapis.com/v2/oauth/token/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY,
          client_secret: env.TIKTOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      };
    },
    parse(body) {
      // TikTok has shipped both a flat and a data-wrapped response shape.
      const d = body?.data && typeof body.data === 'object' ? body.data : body;
      return { accessToken: d?.access_token || null, refreshToken: d?.refresh_token || null };
    },
  },
};

const PLATFORM_NAMES = Object.keys(PLATFORMS);

function createTokenRefresh({ sbGet, sbPatch, sbPost, apiRequest, env = process.env, logger }) {
  if (!sbGet || !sbPatch || !apiRequest) throw new Error('token-refresh: sbGet/sbPatch/apiRequest required');

  async function markReconnectRequired(businessId, platform, reason) {
    const def = PLATFORMS[platform];
    await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
      [def.connectedCol]: false,
    }).catch(() => {});
    await sbPost?.('events', {
      business_id: businessId,
      kind: 'oauth.reconnect_required',
      workflow: 'integrations',
      payload: { platform, reason },
      severity: 'warn',
    }).catch(() => {});
    logger?.warn?.('/token-refresh', businessId, `${platform} reconnect required`, { reason });
  }

  /**
   * Refresh one platform's token for one business. `business` must include
   * the *_enc token columns (pass a full row or select them explicitly).
   * Returns:
   *   { ok:true, accessToken }                     — refreshed + persisted
   *   { ok:false, skipped:true, reason }           — nothing to do (no refresh
   *                                                  token / client creds absent)
   *   { ok:false, reconnectRequired:true, reason } — token rejected; connection
   *                                                  flipped off + event written
   *   { ok:false, transient:true, reason }         — network/5xx; state untouched
   */
  async function refreshPlatform({ business, platform }) {
    const def = PLATFORMS[platform];
    if (!def) throw new Error(`token-refresh: unknown platform ${platform}`);
    const businessId = business?.id;
    if (!businessId) throw new Error('token-refresh: business.id required');

    // Plaintext token columns were dropped (migration 073) — without the
    // encryption key there is nowhere to persist the result, and Twitter/
    // TikTok INVALIDATE the old refresh token on use. Burning a rotating
    // token we can't store would kill the connection, so refuse up front.
    if (!oauthCrypto.isEnabled()) {
      return { ok: false, skipped: true, reason: 'encryption_disabled' };
    }

    const refreshToken = oauthCrypto.readToken(business, def.refreshName);
    if (!refreshToken) {
      // LinkedIn only grants refresh tokens to some programs — an absent one
      // is not proof the access token is dead, so don't flip the connection.
      return { ok: false, skipped: true, reason: 'no_refresh_token' };
    }

    const reqSpec = def.buildRequest(refreshToken, env);
    if (!reqSpec) return { ok: false, skipped: true, reason: 'client_credentials_missing' };

    let r;
    try {
      r = await apiRequest('POST', reqSpec.url, reqSpec.headers, reqSpec.body);
    } catch (e) {
      return { ok: false, transient: true, reason: e.message };
    }

    if (r.status >= 200 && r.status < 300) {
      const { accessToken, refreshToken: rotated } = def.parse(r.body);
      if (!accessToken) {
        // 2xx without a token = provider quirk; treat as transient, don't kill.
        return { ok: false, transient: true, reason: 'no_access_token_in_response' };
      }
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
        ...oauthCrypto.encryptIfEnabled(def.accessName, accessToken),
        // Twitter + TikTok rotate: the old refresh token is dead the moment
        // the new one is issued — persisting it is mandatory, not optional.
        ...(rotated ? oauthCrypto.encryptIfEnabled(def.refreshName, rotated) : {}),
        [def.connectedCol]: true,
      });
      logger?.info?.('/token-refresh', businessId, `${platform} token refreshed`, { rotated: !!rotated });
      return { ok: true, accessToken };
    }

    if (r.status === 400 || r.status === 401) {
      const reason = `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
      await markReconnectRequired(businessId, platform, reason);
      return { ok: false, reconnectRequired: true, reason };
    }

    return { ok: false, transient: true, reason: `http_${r.status}` };
  }

  /** Sweep every business with any of the three platforms connected. */
  async function sweepAll({ limit = 200 } = {}) {
    const select = [
      'id',
      ...PLATFORM_NAMES.flatMap((p) => [
        PLATFORMS[p].connectedCol,
        `${PLATFORMS[p].accessName}_enc`,
        `${PLATFORMS[p].refreshName}_enc`,
      ]),
    ].join(',');
    const rows = await sbGet(
      'businesses',
      `or=(linkedin_connected.eq.true,twitter_connected.eq.true,tiktok_connected.eq.true)&select=${select}&limit=${limit}`
    ).catch(() => []);

    const counts = { businesses: rows.length, refreshed: 0, skipped: 0, reconnectRequired: 0, transient: 0 };
    const failures = [];
    for (const business of rows) {
      for (const platform of PLATFORM_NAMES) {
        if (!business[PLATFORMS[platform].connectedCol]) continue;
        try {
          const res = await refreshPlatform({ business, platform });
          if (res.ok) counts.refreshed += 1;
          else if (res.skipped) counts.skipped += 1;
          else if (res.reconnectRequired) {
            counts.reconnectRequired += 1;
            failures.push({ businessId: business.id, platform, reason: res.reason });
          } else counts.transient += 1;
        } catch (e) {
          counts.transient += 1;
          logger?.warn?.('/token-refresh', business.id, `${platform} refresh threw`, { error: e.message });
        }
      }
    }
    return { ok: true, ...counts, failures };
  }

  return { refreshPlatform, sweepAll, PLATFORM_NAMES };
}

module.exports = createTokenRefresh;
module.exports.PLATFORMS = PLATFORMS;
