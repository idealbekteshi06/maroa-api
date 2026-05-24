'use strict';

/**
 * lib/oauthState.js — signed CSRF state for the PKCE OAuth flows
 * (Twitter/X, TikTok). Mirrors the binding scheme in services/oauth/meta.js
 * but adds the platform so a state minted for one provider can't be replayed
 * against another.
 *
 * State binds: businessId | platform | userId | nonce | ts | HMAC-SHA256.
 * Verified on the exchange to defeat the previous predictable
 * `${business_id}:twitter` state (no nonce, no signature, no expiry).
 */

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

function signOAuthState({ businessId, platform, userId = '', ts = Date.now(), nonce, secret }) {
  if (!secret) throw new Error('signOAuthState: secret required');
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const payload = `${businessId}|${platform}|${userId}|${n}|${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyOAuthState(stateB64, secret, { platform, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!stateB64 || !secret) return null;
  let raw;
  try {
    raw = Buffer.from(String(stateB64), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split('|');
  if (parts.length !== 6) return null;
  const [businessId, statePlatform, userId, nonce, ts, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${businessId}|${statePlatform}|${userId}|${nonce}|${ts}`)
    .digest('hex');
  let ok = false;
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  if (!isUuid(businessId)) return null;
  if (platform && statePlatform !== platform) return null;
  if (!Number.isFinite(Number(ts)) || Date.now() - Number(ts) > maxAgeMs) return null;
  return { businessId, platform: statePlatform, userId: userId || null, nonce, ts: Number(ts) };
}

module.exports = { signOAuthState, verifyOAuthState, isUuid };
