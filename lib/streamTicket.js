'use strict';

/**
 * lib/streamTicket.js — short-lived signed tickets for EventSource (SSE) auth.
 *
 * Browsers cannot attach an Authorization header to an EventSource, and the
 * 2026-05 audit removed ?token= query support from the /webhook auth because
 * long-lived Supabase JWTs leak into request logs. This is the middle path:
 * the dashboard POSTs to /api/stream-ticket (JWT-authed), gets back an HMAC
 * ticket binding user_id + business_id with a 60s expiry, and appends it as
 * ?ticket= on the SSE GET. A leaked ticket is useless after a minute, only
 * opens the two allowlisted read-only streams, and only for the business it
 * was minted for — verified again live by assertBusinessOwner downstream.
 *
 * Mirrors the lib/oauthState.js signing scheme. The two token families may
 * share a secret (both default to N8N_WEBHOOK_SECRET), so the payload leads
 * with the literal purpose 'sse' for domain separation: an OAuth state leads
 * with a UUID and fails the purpose check here, and 'sse' fails oauthState's
 * isUuid(businessId) check there. Neither verifier accepts the other's tokens.
 *
 * Ticket binds: 'sse' | userId | businessId | nonce | ts | HMAC-SHA256.
 */

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const PURPOSE = 'sse';
const STREAM_TICKET_TTL_MS = 60 * 1000; // long enough to open the EventSource, short enough that a logged URL is dead
const FUTURE_SKEW_MS = 5 * 1000; // sign + verify happen on the same box; anything further future-dated is forged or buggy

function signStreamTicket({ userId, businessId, ts = Date.now(), nonce, secret }) {
  if (!secret) throw new Error('signStreamTicket: secret required');
  if (!isUuid(userId)) throw new Error('signStreamTicket: userId must be a valid UUID');
  if (!isUuid(businessId)) throw new Error('signStreamTicket: businessId must be a valid UUID');
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const payload = `${PURPOSE}|${userId}|${businessId}|${n}|${ts}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

/**
 * Returns { userId, businessId, nonce, ts } on success, null on ANY failure
 * (malformed, bad signature, wrong purpose, expired, future-dated, non-UUID
 * fields). Callers must treat null as 401 — never fall through to weaker auth.
 */
function verifyStreamTicket(ticketB64, secret, { maxAgeMs = STREAM_TICKET_TTL_MS, now = Date.now() } = {}) {
  if (!ticketB64 || !secret) return null;
  let raw;
  try {
    raw = Buffer.from(String(ticketB64), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split('|');
  if (parts.length !== 6) return null;
  const [purpose, userId, businessId, nonce, ts, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${purpose}|${userId}|${businessId}|${nonce}|${ts}`)
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
  if (purpose !== PURPOSE) return null;
  if (!isUuid(userId) || !isUuid(businessId)) return null;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return null;
  if (now - tsNum > maxAgeMs) return null;
  if (tsNum - now > FUTURE_SKEW_MS) return null;
  return { userId, businessId, nonce, ts: tsNum };
}

module.exports = { signStreamTicket, verifyStreamTicket, STREAM_TICKET_TTL_MS, isUuid };
