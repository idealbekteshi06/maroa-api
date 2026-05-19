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
 *     webhookEvents.middleware({ provider: 'paddle', sbPost, sbPatch, logger }),
 *     paddleHandler);
 *
 * Two-phase semantics (audit 2026-05-18 hardening):
 *   1. INSERT row with status='received'. Duplicate-PK → short-circuit.
 *   2. Run downstream handler (next()).
 *   3. After response is sent, PATCH status='processed' on 2xx,
 *      status='failed' (+error) on 5xx/throw — so the next retry from
 *      the provider is NOT silently swallowed by the (provider,event_id) PK.
 *
 * The "failed" branch is the safety net: if a Paddle webhook fires
 * `subscription.activated`, our handler crashes on a DB blip, and the
 * row is left as 'received'/'failed' — Paddle's retry policy delivers
 * the same event again, our PK constraint allows the duplicate INSERT
 * to throw, but markProcessed treats status='failed' as "first time"
 * so the handler runs again and the customer's plan is upgraded.
 *
 * Soft-fail mode unchanged: LRU short-circuit survives DB outages.
 */
function middleware({ provider, sbPost, sbPatch, logger, getEventId }) {
  const extract = getEventId || EVENT_ID_EXTRACTORS[provider];
  if (!extract) {
    logger?.warn?.('webhook-events', null, 'no extractor for provider', { provider });
  }
  return async function webhookIdempotency(req, res, next) {
    const eventId = extract ? extract(req.body) : null;
    if (!eventId) return next(); // can't dedup without an id; pass through
    const dedup = await markProcessed({ provider, eventId, sbPost, sbPatch, logger });
    if (!dedup.firstTime) {
      logger?.info?.(req.path, null, 'duplicate webhook event — skipping', { provider, event_id: eventId });
      return res.json({ received: true, duplicate: true, request_id: req.requestId });
    }

    // Phase 2: after the response finishes, transition status based on outcome.
    // We use res.on('finish') so the status reflects the actual HTTP response —
    // if the handler threw and an error middleware sent 500, we mark failed.
    let finished = false;
    res.on('finish', () => {
      if (finished) return;
      finished = true;
      const status = res.statusCode >= 200 && res.statusCode < 400 ? 'processed' : 'failed';
      commitProcessed({
        provider,
        eventId,
        status,
        sbPatch,
        logger,
        responseStatus: res.statusCode,
      }).catch(() => {});
    });
    res.on('close', () => {
      if (finished) return;
      finished = true;
      // Connection closed before handler finished — treat as failed so the
      // provider's retry replays the event.
      commitProcessed({
        provider,
        eventId,
        status: 'failed',
        sbPatch,
        logger,
        responseStatus: 0,
        error: 'connection_closed_before_handler_finished',
      }).catch(() => {});
    });

    next();
  };
}

/**
 * Phase-2 commit: update the webhook_events row to reflect the handler outcome.
 * Idempotent (PATCH with filter), best-effort (DB outage → noop, the LRU still
 * protects in-flight retries within the 5min TTL).
 */
async function commitProcessed({ provider, eventId, status, sbPatch, logger, responseStatus, error }) {
  if (typeof sbPatch !== 'function') return;
  try {
    const patch = {
      processed_at: new Date().toISOString(),
      status,
    };
    if (error) patch.error = String(error).slice(0, 500);
    await sbPatch(
      'webhook_events',
      `provider=eq.${encodeURIComponent(provider)}&event_id=eq.${encodeURIComponent(String(eventId))}`,
      patch
    );
  } catch (e) {
    logger?.warn?.('webhook-events', null, 'commitProcessed failed (will rely on LRU for retry dedup)', {
      provider,
      event_id: eventId,
      error: e.message,
      response_status: responseStatus,
    });
  }
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

async function markProcessed({ provider, eventId, sbPost, sbPatch, sbGet, logger }) {
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
    const result = await sbPost('webhook_events', {
      provider,
      event_id: String(eventId),
      received_at: new Date().toISOString(),
      status: 'received',
    });
    if (!result || (Array.isArray(result) && result.length === 0)) {
      // Conflict path may not have raised — re-read to see status.
      return await _checkExistingStatus({ provider, eventId, sbGet, sbPatch, logger });
    }
    return { firstTime: true, source: 'db' };
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('409') || msg.toLowerCase().includes('duplicate')) {
      // Two-phase recovery: existing row may be 'failed' (previous handler
      // crashed). Re-read; if failed/pending stale → re-run the handler.
      return await _checkExistingStatus({ provider, eventId, sbGet, sbPatch, logger });
    }
    logger?.error?.('webhook-events', null, 'idempotency check failed — failing closed', { error: msg, provider });
    throw e;
  }
}

const _STALE_PENDING_MS = 5 * 60 * 1000;

/**
 * On PK conflict, re-read the row. If status is 'processed', this is a
 * true duplicate — return firstTime:false. If status is 'failed' (prior
 * handler crash) OR 'received'/'pending' older than 5 min (stuck), reset
 * to 'received' and allow the handler to retry.
 */
async function _checkExistingStatus({ provider, eventId, sbGet, sbPatch, logger }) {
  if (typeof sbGet !== 'function') {
    // No way to inspect — conservatively treat as duplicate (status quo).
    return { firstTime: false, source: 'db_conflict_no_read' };
  }
  try {
    const rows = await sbGet(
      'webhook_events',
      `provider=eq.${encodeURIComponent(provider)}&event_id=eq.${encodeURIComponent(String(eventId))}&select=status,received_at&limit=1`
    );
    const row = rows && rows[0];
    if (!row) return { firstTime: true, source: 'db_no_row_after_conflict' };

    if (row.status === 'processed') return { firstTime: false, source: 'db_processed' };
    if (row.status === 'failed') {
      // Previous attempt failed — allow retry. Reset received_at so retention
      // sweeps stay sensible.
      if (typeof sbPatch === 'function') {
        await sbPatch(
          'webhook_events',
          `provider=eq.${encodeURIComponent(provider)}&event_id=eq.${encodeURIComponent(String(eventId))}`,
          { status: 'received', received_at: new Date().toISOString(), error: null }
        );
      }
      return { firstTime: true, source: 'db_retry_after_failure' };
    }
    // status === 'received' (in-flight). If old, treat as stuck and retry.
    const ageMs = Date.now() - new Date(row.received_at).getTime();
    if (ageMs > _STALE_PENDING_MS) {
      if (typeof sbPatch === 'function') {
        await sbPatch(
          'webhook_events',
          `provider=eq.${encodeURIComponent(provider)}&event_id=eq.${encodeURIComponent(String(eventId))}`,
          { status: 'received', received_at: new Date().toISOString() }
        );
      }
      return { firstTime: true, source: 'db_stale_pending_recovered' };
    }
    return { firstTime: false, source: 'db_in_flight' };
  } catch (e) {
    logger?.warn?.('webhook-events', null, '_checkExistingStatus failed', { error: e.message });
    return { firstTime: false, source: 'db_check_error' };
  }
}

module.exports = { markProcessed, commitProcessed, middleware, EVENT_ID_EXTRACTORS };
