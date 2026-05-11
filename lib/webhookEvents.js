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

async function markProcessed({ provider, eventId, sbPost, logger }) {
  if (!provider || !eventId) return { firstTime: true, reason: 'missing provider or eventId' };
  if (typeof sbPost !== 'function') return { firstTime: true, reason: 'sbPost not available' };

  try {
    // Use sbPost with Prefer: resolution=ignore-duplicates so PK violation
    // returns an empty body rather than throwing. We then read the response
    // shape to determine first-time vs duplicate.
    //
    // sbPost helper in server.js issues `Prefer: return=representation` by
    // default which returns the inserted row, OR empty array if the conflict
    // path swallowed it.
    const result = await sbPost('webhook_events', {
      provider,
      event_id: String(eventId),
      received_at: new Date().toISOString(),
    });
    // If sbPost returned a row (object) it was a fresh insert.
    // If it returned undefined / [] the conflict path swallowed it = duplicate.
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return { firstTime: false };
    }
    return { firstTime: true };
  } catch (e) {
    // PostgREST returns 409 on PK violation when ignore-duplicates header
    // is NOT set. sbPost throws on non-2xx. Treat 409 as "duplicate".
    const msg = e?.message || '';
    if (msg.includes('409') || msg.toLowerCase().includes('duplicate')) {
      return { firstTime: false };
    }
    // Other errors: soft-allow processing but log
    logger?.warn?.('webhook-events', null, 'idempotency check failed — soft-allowing', { error: msg, provider });
    return { firstTime: true, reason: `idempotency_soft_fail: ${msg}`, softFail: true };
  }
}

module.exports = { markProcessed, middleware, EVENT_ID_EXTRACTORS };
