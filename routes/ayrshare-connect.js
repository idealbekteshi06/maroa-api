'use strict';

/**
 * routes/ayrshare-connect.js — customer social linking via Ayrshare (2026-07).
 *
 *   POST /webhook/ayrshare-connect-start  — ensure the business has an
 *          Ayrshare user profile (created on first call, key persisted to
 *          businesses.ayrshare_profile_key) and return a short-lived SSO
 *          URL where the customer links Facebook/Instagram/TikTok/etc.
 *          Ayrshare's own Meta app is App-Review-approved, so this path
 *          publishes to FB/IG WITHOUT our Meta app needing review.
 *   POST /webhook/ayrshare-connect-status — re-read the profile's linked
 *          networks from Ayrshare and persist them to
 *          businesses.ayrshare_connected_platforms.
 *
 * Requires (Ayrshare Business plan): AYRSHARE_API_KEY, and for SSO links
 * AYRSHARE_PRIVATE_KEY (RSA key from the Ayrshare dashboard) +
 * AYRSHARE_DOMAIN (the "domain" id Ayrshare assigns). Missing config
 * soft-fails with a reason code — never a 500.
 *
 * /webhook/* rides the global JWT + owner middleware.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUUID = (v) => typeof v === 'string' && UUID_RE.test(v);

// Ayrshare network names → our platform slugs
const NETWORK_MAP = {
  facebook: 'facebook',
  fbg: 'facebook',
  instagram: 'instagram',
  linkedin: 'linkedin',
  pinterest: 'pinterest',
  tiktok: 'tiktok',
  youtube: 'youtube',
  threads: 'threads',
};

async function ayrshareFetch({ path, method = 'GET', body, profileKey, timeoutMs = 15000 }) {
  const apiKey = process.env.AYRSHARE_API_KEY;
  if (!apiKey) return { ok: false, reason: 'AYRSHARE_API_KEY not configured' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.ayrshare.com/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(profileKey ? { 'Profile-Key': profileKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, reason: json?.message || `ayrshare ${res.status}`, json };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'ayrshare timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

function register({ app, sbGet, sbPatch, apiError, logger }) {
  if (!app || !sbGet || !sbPatch) throw new Error('ayrshare-connect routes: app + sbGet + sbPatch required');

  app.post('/webhook/ayrshare-connect-start', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'businessId (UUID) required');
    try {
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=business_name,ayrshare_profile_key`
      ).catch(() => []);
      const business = rows?.[0];
      if (!business) return apiError(res, 404, 'BUSINESS_NOT_FOUND', 'business not found');

      let profileKey = business.ayrshare_profile_key;
      if (!profileKey) {
        const created = await ayrshareFetch({
          path: '/profiles',
          method: 'POST',
          body: { title: String(business.business_name || businessId).slice(0, 80) },
        });
        if (!created.ok) {
          logger?.warn?.('ayrshare-connect', businessId, 'profile create failed', { reason: created.reason });
          return apiError(res, 502, 'AYRSHARE_UNAVAILABLE', 'Social linking is not available right now');
        }
        profileKey = created.json?.profileKey;
        if (!profileKey) return apiError(res, 502, 'AYRSHARE_UNAVAILABLE', 'Social linking is not available right now');
        await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
          ayrshare_profile_key: profileKey,
        });
      }

      const privateKey = process.env.AYRSHARE_PRIVATE_KEY;
      const domain = process.env.AYRSHARE_DOMAIN;
      if (!privateKey || !domain) {
        return apiError(
          res,
          503,
          'AYRSHARE_SSO_NOT_CONFIGURED',
          'Social linking is almost ready — the operator must set AYRSHARE_PRIVATE_KEY + AYRSHARE_DOMAIN'
        );
      }
      const jwt = await ayrshareFetch({
        path: '/profiles/generateJWT',
        method: 'POST',
        body: {
          domain,
          privateKey: privateKey.replace(/\\n/g, '\n'),
          profileKey,
          logout: true,
        },
      });
      if (!jwt.ok || !jwt.json?.url) {
        logger?.warn?.('ayrshare-connect', businessId, 'generateJWT failed', { reason: jwt.reason });
        return apiError(res, 502, 'AYRSHARE_UNAVAILABLE', 'Social linking is not available right now');
      }
      res.json({ ok: true, url: jwt.json.url, expires_in_minutes: 5 });
    } catch (e) {
      logger?.error?.('/webhook/ayrshare-connect-start', businessId, e.message);
      apiError(res, 500, 'AYRSHARE_CONNECT_FAILED', 'Social linking failed');
    }
  });

  app.post('/webhook/ayrshare-connect-status', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!isUUID(businessId)) return apiError(res, 400, 'INVALID_BUSINESS_ID', 'businessId (UUID) required');
    try {
      const rows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=ayrshare_profile_key`
      ).catch(() => []);
      const business = rows?.[0];
      if (!business) return apiError(res, 404, 'BUSINESS_NOT_FOUND', 'business not found');
      if (!business.ayrshare_profile_key) return res.json({ ok: true, connected: [], linked: false });

      const user = await ayrshareFetch({ path: '/user', profileKey: business.ayrshare_profile_key });
      if (!user.ok) {
        logger?.warn?.('ayrshare-connect', businessId, 'user fetch failed', { reason: user.reason });
        return apiError(res, 502, 'AYRSHARE_UNAVAILABLE', 'Could not check linked accounts right now');
      }
      const raw = Array.isArray(user.json?.activeSocialAccounts) ? user.json.activeSocialAccounts : [];
      const connected = [...new Set(raw.map((n) => NETWORK_MAP[String(n).toLowerCase()]).filter(Boolean))];
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
        ayrshare_connected_platforms: connected,
      }).catch(() => {});
      res.json({ ok: true, linked: true, connected });
    } catch (e) {
      logger?.error?.('/webhook/ayrshare-connect-status', businessId, e.message);
      apiError(res, 500, 'AYRSHARE_STATUS_FAILED', 'Could not check linked accounts');
    }
  });
}

module.exports = { register };
