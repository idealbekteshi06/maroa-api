// Accepts EITHER a Supabase user JWT (Authorization header OR ?token= query) OR the n8n webhook secret.
// Attaches req.user and req.businessId when authenticated via JWT.

'use strict';

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

const supabaseAdmin = createClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

if (supabaseAdmin) {
  console.log('[auth] supabaseAdmin initialized OK — JWT verification enabled');
} else {
  console.warn('[auth] supabaseAdmin NOT initialized — JWT verification disabled', {
    hasUrl: !!SUPABASE_URL,
    urlLen: SUPABASE_URL.length,
    hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
    keyLen: SUPABASE_SERVICE_ROLE_KEY.length,
    envKeyRaw: (process.env.SUPABASE_KEY || '').length,
    envServiceRaw: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length,
  });
}

const OPEN_PATHS = new Set([
  '/webhook/paddle-webhook',
  '/webhook/email-approve',
  '/webhook/dashboard-events',
]);

function requireAuthOrWebhookSecret(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const pathOnly = req.originalUrl.split('?')[0];
  if (OPEN_PATHS.has(pathOnly)) return next();

  // 1. Machine path: webhook secret
  const providedSecret = (req.get('x-webhook-secret') || '').trim();
  if (N8N_WEBHOOK_SECRET && providedSecret && providedSecret === N8N_WEBHOOK_SECRET) {
    req.authSource = 'webhook';
    return next();
  }

  // 2. User path: Supabase JWT from Authorization header OR ?token= query param (for SSE)
  let token = null;
  const authHeader = req.get('authorization') || '';
  const headerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (headerMatch) {
    token = headerMatch[1].trim();
  } else if (req.query && typeof req.query.token === 'string' && req.query.token.length > 20) {
    token = req.query.token.trim();
  }

  if (token && supabaseAdmin) {
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
    return;
  }

  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing authentication (provide Authorization: Bearer <jwt>, ?token=<jwt>, or x-webhook-secret)',
      timestamp: new Date().toISOString(),
      _debug: {
        hasBearer: !!match,
        hasSbAdmin: !!supabaseAdmin,
        hasCreateClient: !!createClient,
        hasUrl: !!SUPABASE_URL,
        hasKey: !!SUPABASE_SERVICE_ROLE_KEY,
        hasQueryToken: !!(req.query && req.query.token),
      },
    },
  });
}

module.exports = { requireAuthOrWebhookSecret };
