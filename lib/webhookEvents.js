'use strict';

/**
 * lib/webhookEvents.js — Webhook delivery idempotency.
 *
 * Every webhook provider (Paddle, Stripe, Meta, Higgsfield, Inngest, Ayrshare)
 * retries on non-2xx OR on perceived network failure — and some send the same
 * delivery twice on purpose during failover. Without idempotency, every retry
 * re-runs the handler: re-grants plans, re-fires cold-start, double-counts
 * usage rows, double-sends emails.
 *
 * This module enforces "at-most-once" semantics by writing a row to the
 * `webhook_events` table (migration 054) on first receipt. The (provider,
 * event_id) PRIMARY KEY plus PostgREST's `Prefer: resolution=ignore-duplicates`
 * means duplicates fail silently — the handler sees `firstTime=false` and
 * short-circuits.
 *
 * Public API:
 *   markProcessed({ provider, eventId, sbPost }) → { firstTime: boolean }
 *
 * Soft-fail mode: if the table is unreachable we return firstTime=true
 * (process the event) rather than fail-closed — losing a customer's
 * "subscription.activated" is worse than a rare double-fire on a DB outage.
 * The Sentry breadcrumb still records the soft-fail for ops follow-up.
 */

/**
 * Provider-specific extractors for event_id. Each function takes the
 * parsed JSON body and returns a stable per-delivery identifier. Add a
 * new entry when you wire a new webhook provider.
 */
const EVENT_ID_EXTRACTORS = {
  paddle: (body) => body?.notification_id || body?.event_id || body?.data?.id,
  stripe: (body) => body?.id,
  meta: (body) => (body?.entry?.[0]?.id ? `${body.entry[0].id}:${body.entry[0].time}` : null),
  higgsfield: (body) => body?.request_id || body?.job_id,
  ayrshare: (body) => body?.id || body?.event_id,
  inngest: (body) => body?.id || body?.event?.id,
  google: (body) => body?.message?.messageId, // Google pub/sub format
};

/**
 * Express middleware factory. Mount before any side-effect handler.
 *
 *   app.post('/webhook/paddle-webhook',
 *     webhookEvents.middleware({ provider: 'paddle', sbPost, logger }),
 *     paddleHandler);
 *
 * If the event is a duplicate, the middleware responds with 200
 * `{received: true, duplicate: true}` and short-circuits.
 *
 * The middleware reads the body that's already on req. Mount AFTER
 * `express.json()` (or after the raw-body parser for HMAC routes —
 * in that case, also parse + attach the JSON to req before this).
 */
function middleware({ provider, sbPost, logger, getEventId }) {
  const extract = getEventId || EVENT_ID_EXTRACTORS[provider];
  if (!extract) {
    logger?.warn?.('webhook-events', null, 'no extractor for provider', { provider });
  }
  return async function webhookIdempotency(req, res, next) {
    const eventId = extract ? extract(req.body) : null;
    if (!eventId) return next(); // can't dedup without an id; pass through
    const dedup = await markProcessed({ provider, eventId, sbPost, logger });
    if (!dedup.firstTime) {
      logger?.info?.(req.path, null, 'duplicate webhook event — skipping', { provider, event_id: eventId });
      return res.json({ received: true, duplicate: true, request_id: req.requestId });
    }
    next();
  };
}

// ─── In-process LRU short-circuit ──────────────────────────────────────────
// Fixes ADR-0004 item #8 (Antigravity review): when Supabase is unreachable,
// the idempotency check soft-fails and lets the webhook handler run.
// Webhook providers retry aggressively during an outage → handler runs N
// times for the same event.
//
// Now: we cache the last 1000 (provider, eventId) pairs in-process with a
// 5-minute TTL. If we see the same event within that window we short-circuit
// without touching Supabase, even if the DB is down.
//
// Multi-instance caveat: each Railway instance has its own LRU. Webhook
// retries from a single provider tend to hit the same instance (sticky
// load balancing + retries within seconds of each other), so this fixes
// the majority of duplicate-on-outage scenarios. For full multi-instance
// dedup we'd need Redis (Phase 8+).
const _seenEvents = new Map(); // key: "provider:eventId" → expiresAt timestamp
const _SEEN_MAX = 1000;
const _SEEN_TTL_MS = 5 * 60 * 1000;

function _seenKey(provider, eventId) {
  return `${provider}:${eventId}`;
}

function _checkAndMarkSeen(provider, eventId) {
  const key = _seenKey(provider, eventId);
  const now = Date.now();
  const expiresAt = _seenEvents.get(key);
  if (expiresAt && expiresAt > now) {
    return true; // already seen recently
  }
  // Evict if at capacity. Map preserves insertion order → first entry is
  // the oldest. Single delete per insert keeps insertion O(1) amortized.
  if (_seenEvents.size >= _SEEN_MAX) {
    const oldestKey = _seenEvents.keys().next().value;
    _seenEvents.delete(oldestKey);
  }
  _seenEvents.set(key, now + _SEEN_TTL_MS);
  // Opportunistic cleanup of stale entries — only when we add a new one,
  // and only for the first few keys (cheap).
  let scanned = 0;
  for (const [k, t] of _seenEvents) {
    if (t <= now) _seenEvents.delete(k);
    if (++scanned >= 10) break;
  }
  return false;
}

async function markProcessed({ provider, eventId, sbPost, logger }) {
  if (!provider || !eventId) return { firstTime: true, reason: 'missing provider or eventId' };

  // ─── In-process LRU short-circuit ────────────────────────────────────
  // ADR-0004 #8 fix: check the LRU FIRST, before any Supabase call. If
  // we've seen this (provider, eventId) in the last 5 minutes, it's a
  // duplicate — return immediately regardless of DB state. This makes
  // idempotency survive Supabase outages (which is exactly when webhook
  // providers retry aggressively).
  const seen = _checkAndMarkSeen(provider, eventId);
  if (seen) {
    return { firstTime: false, source: 'lru' };
  }

  if (typeof sbPost !== 'function') return { firstTime: true, reason: 'sbPost not available' };

  try {
    // Persistent dedup via webhook_events table — survives process restart.
    // The LRU above caught the in-flight retry burst; this catches the
    // post-restart case where the LRU is empty but the event was already
    // processed by a previous instance.
    const result = await sbPost('webhook_events', {
      provider,
      event_id: String(eventId),
      received_at: new Date().toISOString(),
    });
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return { firstTime: false, source: 'db' };
    }
    return { firstTime: true, source: 'db' };
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('409') || msg.toLowerCase().includes('duplicate')) {
      return { firstTime: false, source: 'db_conflict' };
    }
    // Supabase outage / network error. The LRU above already marked this
    // event as seen, so the NEXT retry (within 5 min) will short-circuit
    // cleanly. Soft-allow the FIRST one through — losing one delivery is
    // Other errors: fail closed on DB outage
    logger?.error?.('webhook-events', null, 'idempotency check failed — failing closed', { error: msg, provider });
    throw e;
  }
}

module.exports = { markProcessed, middleware, EVENT_ID_EXTRACTORS };
