'use strict';

/**
 * routes/stream-ticket.js — mint short-lived SSE auth tickets.
 *
 * POST /api/stream-ticket  { business_id }  →  { ticket, expires_in }
 *
 * Auth: requireAnyUserId is mounted on this prefix in server.js (Bearer JWT,
 * sets req.user), and the handler verifies the caller owns business_id before
 * signing. The ticket is then accepted as ?ticket= by
 * middleware/requireAuthOrWebhookSecret.js on the allowlisted GET SSE routes
 * (/webhook/dashboard-events, /webhook/wf15-stream/:id) — the only way a
 * browser EventSource, which cannot send an Authorization header, can
 * authenticate. See lib/streamTicket.js for the token format and expiry.
 */

const { signStreamTicket, STREAM_TICKET_TTL_MS, isUuid } = require('../lib/streamTicket');
const { assertBusinessOwner } = require('../lib/assertBusinessOwner');
const { limits } = require('../lib/rateLimiters');

function register({ app, sbGet, apiError, logger, env }) {
  if (!app) throw new Error('routes/stream-ticket: app required');
  if (typeof sbGet !== 'function') throw new Error('routes/stream-ticket: sbGet required');
  if (typeof apiError !== 'function') throw new Error('routes/stream-ticket: apiError required');

  const secret = String(env?.STREAM_TICKET_SECRET || env?.N8N_WEBHOOK_SECRET || '').trim();

  app.post('/api/stream-ticket', limits.standardMutate, async (req, res) => {
    // requireAnyUserId (server.js mount) guarantees req.user — belt-and-braces.
    if (!req.user?.id) {
      return apiError(res, 401, 'UNAUTHORIZED', 'JWT required to mint a stream ticket');
    }
    const businessId = req.body?.business_id || req.body?.businessId;
    if (!businessId || !isUuid(businessId)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');
    }
    if (!secret) {
      return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Stream ticket signing secret not configured');
    }
    if (!(await assertBusinessOwner(req, res, businessId, { sbGet, apiError, logger }))) return;
    const ticket = signStreamTicket({ userId: req.user.id, businessId, secret });
    res.json({ ticket, expires_in: Math.floor(STREAM_TICKET_TTL_MS / 1000) });
  });
}

module.exports = { register };
