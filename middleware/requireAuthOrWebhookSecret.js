// Accepts EITHER a Supabase user JWT (Authorization header) OR the n8n webhook secret,
// OR — on the allowlisted GET SSE routes only — a short-lived signed stream ticket
// (?ticket=, minted by POST /api/stream-ticket; see lib/streamTicket.js).
// Attaches req.user and req.businessId when authenticated via JWT or ticket.

'use strict';

const crypto = require('crypto');
const { verifyStreamTicket } = require('../lib/streamTicket');

let createClient;
try {
  createClient = require('@supabase/supabase-js').createClient;
  console.log('[auth] @supabase/supabase-js loaded OK');
} catch (e) {
  console.error('[auth] FAILED to load @supabase/supabase-js:', e.message);
  createClient = null;
}

const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
const N8N_WEBHOOK_SECRET = clean(process.env.N8N_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET);
const STREAM_TICKET_SECRET = clean(process.env.STREAM_TICKET_SECRET) || N8N_WEBHOOK_SECRET;

const supabaseAdmin =
  createClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

if (!supabaseAdmin) {
  console.warn('[auth] supabaseAdmin NOT initialized — JWT verification disabled');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

const OPEN_PATHS = new Set([
  '/webhook/paddle-webhook',
  '/webhook/email-approve',
  '/webhook/data-deletion-request',
  '/webhook/meta-deauthorize',
  '/webhook/meta-data-deletion',
  '/api/data-deletion-status',
]);

// GET-only SSE endpoints that may authenticate with a short-lived signed
// ticket (?ticket=) minted by POST /api/stream-ticket. EventSource cannot
// attach an Authorization header, and the audit removed general ?token=
// support because long-lived JWTs leak into request logs — a 60s
// business-bound ticket is the narrow exception. Keep this list tight:
// read-only streams only, never mutating routes.
function isStreamTicketPath(pathOnly) {
  return pathOnly === '/webhook/dashboard-events' || pathOnly.startsWith('/webhook/wf15-stream/');
}

function requireAuthOrWebhookSecret(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const pathOnly = req.originalUrl.split('?')[0];
  if (OPEN_PATHS.has(pathOnly)) return next();

  // 1. Machine path: webhook secret (timing-safe)
  const providedSecret = (req.get('x-webhook-secret') || '').trim();
  if (N8N_WEBHOOK_SECRET && providedSecret && timingSafeEqual(providedSecret, N8N_WEBHOOK_SECRET)) {
    req.authSource = 'webhook';
    return next();
  }

  // 2. Stream-ticket path: GET + allowlisted SSE route + ?ticket= only.
  // A present-but-invalid ticket is a hard 401 — never fall through to
  // weaker auth. The ticket already binds business_id; requiring the query
  // param to match makes the binding explicit at the auth layer, and the
  // assertBusinessOwner gate downstream re-verifies live ownership with the
  // ticket's user_id (defense in depth).
  const ticket = typeof req.query?.ticket === 'string' ? req.query.ticket : null;
  if (ticket && req.method === 'GET' && isStreamTicketPath(pathOnly)) {
    const verified = STREAM_TICKET_SECRET ? verifyStreamTicket(ticket, STREAM_TICKET_SECRET) : null;
    if (!verified) {
      return res.status(401).json({
        error: {
          code: 'INVALID_STREAM_TICKET',
          message: 'Stream ticket invalid or expired — fetch a new one from POST /api/stream-ticket',
          timestamp: new Date().toISOString(),
        },
      });
    }
    const qBusinessId = req.query?.business_id;
    if (!qBusinessId || String(qBusinessId) !== verified.businessId) {
      return res.status(403).json({
        error: {
          code: 'STREAM_TICKET_BUSINESS_MISMATCH',
          message: 'business_id does not match the stream ticket',
          timestamp: new Date().toISOString(),
        },
      });
    }
    req.user = { id: verified.userId };
    req.authSource = 'stream-ticket';
    req.streamTicket = { userId: verified.userId, businessId: verified.businessId, issuedAt: verified.ts };
    return next();
  }

  // 3. User path: Supabase JWT from Authorization header only (no ?token= query)
  const authHeader = req.get('authorization') || '';
  const headerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = headerMatch ? headerMatch[1].trim() : null;

  if (token && supabaseAdmin) {
    supabaseAdmin.auth
      .getUser(token)
      .then(({ data, error }) => {
        if (error || !data?.user) {
          return res.status(401).json({
            error: { code: 'UNAUTHORIZED', message: 'Invalid auth token', timestamp: new Date().toISOString() },
          });
        }
        req.user = data.user;
        req.authSource = 'jwt';
        return next();
      })
      .catch((err) => {
        console.error('[auth] JWT verification failed:', err?.message || err);
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Auth verification failed', timestamp: new Date().toISOString() },
        });
      });
    return;
  }

  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing authentication (provide Authorization: Bearer <jwt> or x-webhook-secret)',
      timestamp: new Date().toISOString(),
    },
  });
}

module.exports = { requireAuthOrWebhookSecret };
