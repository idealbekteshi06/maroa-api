// Accepts EITHER a Supabase user JWT (from frontend) OR the n8n webhook secret (from automation).
// Attaches req.user and req.businessId when authenticated via JWT.

'use strict';

const { createClient } = require('@supabase/supabase-js');

const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_URL = clean(process.env.SUPABASE_URL) || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY) || clean(process.env.SUPABASE_KEY) || '';
const N8N_WEBHOOK_SECRET = clean(process.env.N8N_WEBHOOK_SECRET) || clean(process.env.WEBHOOK_SECRET) || '';

// Service-role client — used ONLY to verify JWTs server-side
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Routes that must stay open (no auth at all)
const OPEN_PATHS = new Set([
  '/webhook/paddle-webhook',
  '/webhook/email-approve',
  '/webhook/dashboard-events',
]);

function requireAuthOrWebhookSecret(req, res, next) {
  // Always allow CORS preflight
  if (req.method === 'OPTIONS') return next();

  // Allow explicitly-open paths
  const pathOnly = req.originalUrl.split('?')[0];
  if (OPEN_PATHS.has(pathOnly)) return next();

  // 1. Machine path: valid webhook secret (for n8n / cron)
  const providedSecret = (req.get('x-webhook-secret') || '').trim();
  if (N8N_WEBHOOK_SECRET && providedSecret && providedSecret === N8N_WEBHOOK_SECRET) {
    req.authSource = 'webhook';
    return next();
  }

  // 2. User path: Supabase JWT
  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && supabaseAdmin) {
    const token = match[1].trim();
    supabaseAdmin.auth.getUser(token)
      .then(({ data, error }) => {
        if (error || !data?.user) {
          return res.status(401).json({
            error: { code: 'UNAUTHORIZED', message: 'Invalid auth token', timestamp: new Date().toISOString() }
          });
        }
        req.user = data.user;
        req.businessId = data.user.id;
        req.authSource = 'jwt';
        return next();
      })
      .catch(err => {
        console.error('[auth] JWT verification failed:', err?.message || err);
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Auth verification failed', timestamp: new Date().toISOString() }
        });
      });
    return; // async path
  }

  // 3. Neither provided — reject
  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing authentication (provide Authorization: Bearer <jwt> or x-webhook-secret)',
      timestamp: new Date().toISOString(),
    },
  });
}

if (!supabaseAdmin) {
  console.warn('[auth] WARNING: No SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY — JWT auth disabled, webhook-secret only');
}

module.exports = { requireAuthOrWebhookSecret };
