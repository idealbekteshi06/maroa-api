'use strict';

/**
 * services/inngest/dlqRecorder.js
 *
 * Helper used inside every Inngest function's `onFailure` handler.
 * Persists a row to `inngest_dlq` (migration 058) so terminal failures
 * are recoverable and observable.
 *
 * Usage in services/inngest/functions.js:
 *
 *   const fn = inngest.createFunction(
 *     {
 *       id: 'my-job',
 *       retries: 3,
 *       onFailure: dlqHandler({ functionId: 'my-job', eventName: 'maroa/my-event' }),
 *       triggers: [...],
 *     },
 *     async ({ event, step }) => { ... }
 *   );
 *
 * The handler reaches Supabase directly via HTTPS (no app-server
 * roundtrip) so DLQ recording works even when the API is unreachable
 * — which is often when an Inngest job fails hardest.
 *
 * Soft-failure: never throws. If Supabase is down too, we log to stderr
 * and let Sentry pick up the breadcrumb.
 */

const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '')
  .replace(/[^\x20-\x7E]/g, '')
  .trim();

function postRow(table, row) {
  return new Promise((resolve) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return resolve({ ok: false, reason: 'no supabase creds' });
    const u = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    const body = JSON.stringify(row);
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Prefer: 'return=minimal',
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode === 201, status: res.statusCode }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Direct Slack webhook ping. Used for DLQ alerts so even if the main
 * alertRouter wiring fails, the founder still gets paged. Mirrors the
 * "reach Slack directly via HTTPS" approach we use for Supabase here —
 * keep DLQ alerting independent of any in-process state.
 */
function postSlack(message) {
  return new Promise((resolve) => {
    const url = (process.env.SLACK_ALERT_WEBHOOK_URL || '').trim();
    if (!url) return resolve({ ok: false, reason: 'no_slack_webhook' });
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, reason: 'invalid_slack_url' });
    }
    const body = JSON.stringify({ text: message });
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    };
    const req = https.request(opts, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Build an `onFailure` callback for an Inngest function.
 *
 * Inngest invokes onFailure with the same shape as the function handler
 * plus an `error` field containing the terminal error.
 *
 * Two side effects (M4 hardening):
 *   1. INSERT row into inngest_dlq so the failure is dashboardable + replayable.
 *   2. Fire a Slack alert + Sentry capture so ops sees terminal failures
 *      in real time. No more "silent for 48h, customer notices first."
 */
function dlqHandler({ functionId, eventName } = {}) {
  return async ({ event, error }) => {
    const businessId = event?.data?.businessId || event?.data?.business_id || null;
    const row = {
      function_id: functionId || 'unknown',
      event_name: eventName || event?.name || 'unknown',
      event_id: event?.id || null,
      business_id: businessId,
      attempt_count: event?.attempt_count || 1,
      error_message: (error?.message || String(error || 'unknown error')).slice(0, 4000),
      error_stack: error?.stack ? String(error.stack).slice(0, 8000) : null,
      event_data: event?.data || null,
    };
    try {
      const r = await postRow('inngest_dlq', row);
      if (!r.ok) {
        console.error(`[inngest-dlq] FAILED to persist: ${JSON.stringify({ ...row, reason: r })}`);
      }
    } catch (e) {
      console.error(`[inngest-dlq] handler threw: ${e.message}`);
    }

    // ── Alert side-effect — never let it block the DLQ recording ──
    try {
      // Sentry capture (in-process, free if SDK isn't loaded).
      try {
        // eslint-disable-next-line global-require
        const Sentry = require('@sentry/node');
        Sentry.captureMessage(`inngest_dlq:${row.function_id}`, {
          level: 'error',
          tags: {
            function_id: row.function_id,
            event_name: row.event_name,
            business_id: businessId || 'unknown',
          },
          extra: {
            error_message: row.error_message,
            attempt_count: row.attempt_count,
          },
        });
      } catch {
        /* Sentry not loaded — soft-skip */
      }

      // Slack — direct HTTPS, no shared state.
      const msg =
        `:rotating_light: *Inngest DLQ* — \`${row.function_id}\` failed after ${row.attempt_count} attempts\n` +
        `> ${row.error_message.slice(0, 300)}\n` +
        `event: \`${row.event_name}\` · business: \`${businessId || 'n/a'}\``;
      // 5 min rate limit on the same function_id to avoid storm.
      if (!_recentlyAlerted(row.function_id)) {
        postSlack(msg).catch(() => {});
      }
    } catch (e) {
      console.error(`[inngest-dlq] alert side-effect threw: ${e.message}`);
    }

    return { dlq_recorded: true };
  };
}

// 5-min per-function-id rate limit on the Slack ping so a stuck function
// doesn't spam #alerts.
const _alertRateLimit = new Map();
function _recentlyAlerted(functionId) {
  const now = Date.now();
  const expiresAt = _alertRateLimit.get(functionId);
  if (expiresAt && expiresAt > now) return true;
  _alertRateLimit.set(functionId, now + 5 * 60 * 1000);
  // Sweep stale entries opportunistically.
  let scanned = 0;
  for (const [k, t] of _alertRateLimit) {
    if (t <= now) _alertRateLimit.delete(k);
    if (++scanned >= 20) break;
  }
  return false;
}

module.exports = { dlqHandler, postSlack, _recentlyAlerted };
