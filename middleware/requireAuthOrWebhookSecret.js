// Accepts EITHER a Supabase user JWT (Authorization header) OR the n8n webhook secret.
// Attaches req.user and req.businessId when authenticated via JWT.

'use strict';

const crypto = require('crypto');

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

  // 2. User path: Supabase JWT from Authorization header only (no ?token= query)
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
