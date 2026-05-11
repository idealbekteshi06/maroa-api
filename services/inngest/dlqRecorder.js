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
 * Build an `onFailure` callback for an Inngest function.
 *
 * Inngest invokes onFailure with the same shape as the function handler
 * plus an `error` field containing the terminal error.
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
        // Last-ditch — write to stderr so Railway log scraping catches it.
        console.error(`[inngest-dlq] FAILED to persist: ${JSON.stringify({ ...row, reason: r })}`);
      }
    } catch (e) {
      console.error(`[inngest-dlq] handler threw: ${e.message}`);
    }
    return { dlq_recorded: true };
  };
}

module.exports = { dlqHandler };
