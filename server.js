// server.js — Maroa.ai Webhook API Server v2.0
// Layer 1: Execution  | Layer 2: Intelligence  | Layer 3: Learning
// The AI does everything forever and gets smarter every week.

'use strict';

// ─── Boot-time env validation. Crashes loudly on misconfiguration. ──────────
// Must run before any module that reads process.env at import time.
const env = require('./lib/env').parse();
// Railway injects PORT (e.g. 8080) — resolve before early listen (~line 330)
const PORT = Number(process.env.PORT) || Number(env.PORT) || 3000;

// OpenTelemetry — opt-in via OTEL_ENABLED=true. Must init BEFORE any
// instrumented module is required (the SDK monkey-patches at require-time).
require('./lib/otel').init();

const Sentry = require('@sentry/node');
if (env.SENTRY_DSN) {
  // PII scrubber — strip auth headers, tokens, secrets, and user emails from
  // every event before it leaves the process. Saves us from leaking customer
  // data into Sentry when an error path serializes a full request object.
  const PII_KEY_PATTERN =
    /(authorization|auth_token|api_key|apikey|secret|token|password|email|access_token|refresh_token|jwt|bearer)/i;
  const scrub = (obj, depth = 0) => {
    if (!obj || depth > 6) return obj;
    if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1));
    if (typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (PII_KEY_PATTERN.test(k)) {
          out[k] = '[redacted]';
        } else if (typeof v === 'string' && /sk-ant-|sb_secret_|r8_|Bearer\s/i.test(v)) {
          out[k] = '[redacted]';
        } else {
          out[k] = scrub(v, depth + 1);
        }
      }
      return out;
    }
    return obj;
  };
  // Resolve a release tag for source-map matching + cross-deploy
  // error attribution. Preference order:
  //   1. env.RELEASE (explicit, set in Railway env)
  //   2. RAILWAY_GIT_COMMIT_SHA (auto-set by Railway on every deploy)
  //   3. `git describe --tags` (local dev / manual deploys)
  // Falling through all three leaves release=undefined which is fine for
  // local but warned-on in prod by lib/startupSelfTest.
  const _resolvedRelease = (() => {
    if (env.RELEASE) return env.RELEASE;
    if (process.env.RAILWAY_GIT_COMMIT_SHA) {
      return `maroa-api@${String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 12)}`;
    }
    try {
      // eslint-disable-next-line global-require
      const { execSync } = require('child_process');
      const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (sha) return `maroa-api@${sha}`;
    } catch {
      /* git not available — release stays undefined */
    }
    return undefined;
  })();
  if (env.NODE_ENV === 'production' && !_resolvedRelease) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'sentry_release_not_set_in_prod',
        hint: 'Set RELEASE env or RAILWAY_GIT_COMMIT_SHA so Sentry can match source maps.',
      })
    );
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: _resolvedRelease,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend(event) {
      try {
        if (event.request) {
          if (event.request.headers) event.request.headers = scrub(event.request.headers);
          if (event.request.cookies) event.request.cookies = '[redacted]';
          if (event.request.data) event.request.data = scrub(event.request.data);
        }
        if (event.extra) event.extra = scrub(event.extra);
        if (event.contexts) event.contexts = scrub(event.contexts);
      } catch {
        // Never let scrubbing crash the error path
      }
      return event;
    },
  });
}
const express = require('express');
const cors = require('cors');
const expressRateLimit = require('express-rate-limit');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { randomUUID: uuidv4 } = require('crypto');
const { validate } = require('./lib/validators');
const { checkRateLimit } = require('./lib/rateLimit');
const { zodValidate, businessIdBody } = require('./lib/schemas');
const { fire: fireBreaker, CircuitOpenError } = require('./lib/breakers');
const { retryWithJitter } = require('./lib/retryWithJitter');
const SERVICE_TIMEOUTS_MS = require('./lib/serviceTimeouts');
const externalHttp = require('./lib/externalHttp');
const { assertPublicHttpUrl } = require('./lib/ssrfGuard');
const planGate = require('./middleware/planGate');
const { checkPlanLimit, PLAN_LIMITS, normalizePlan } = require('./middleware/planLimits');
const paddle = require('./services/paddle');

const logger = {
  info: (route, businessId, message, data = {}) => {
    console.log(
      JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        route,
        business_id: businessId,
        message,
        ...data,
      })
    );
  },
  error: (route, businessId, message, error, data = {}) => {
    console.error(
      JSON.stringify({
        level: 'error',
        timestamp: new Date().toISOString(),
        route,
        business_id: businessId,
        message,
        error: error?.message || error,
        stack: error?.stack,
        ...data,
      })
    );
  },
  warn: (route, businessId, message, data = {}) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        timestamp: new Date().toISOString(),
        route,
        business_id: businessId,
        message,
        ...data,
      })
    );
  },
};

// Forward bindings for routes registered before the deferred route table loads.
let sendEmail = async () => ({ sent: false, reason: 'routes_loading' });
let memoryService = null;

function log(route, msg) {
  console.log(`[${new Date().toISOString()}] ${route} — ${msg}`);
}

// Module-level PII scrubber for anything we persist (e.g. errors.retry_payload).
// Mirrors the Sentry beforeSend scrubber so request bodies stored for retry
// don't leak OAuth tokens / emails into the DB error sink.
const _PII_KEY_PATTERN =
  /(authorization|auth_token|api_key|apikey|secret|token|password|email|access_token|refresh_token|jwt|bearer)/i;
function scrubPII(obj, depth = 0) {
  if (!obj || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrubPII(v, depth + 1));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (_PII_KEY_PATTERN.test(k)) out[k] = '[redacted]';
      else if (typeof v === 'string' && /sk-ant-|sb_secret_|r8_|Bearer\s/i.test(v)) out[k] = '[redacted]';
      else out[k] = scrubPII(v, depth + 1);
    }
    return out;
  }
  return obj;
}

function apiError(res, status, code, message, details = null) {
  return res.status(status).json({
    error: {
      code,
      message,
      details,
      timestamp: new Date().toISOString(),
    },
  });
}

const app = express();

// ─── Trust proxy ──────────────────────────────────────────────────────────────
// Required when running behind Railway's TLS terminator (or any reverse proxy).
// Without this, req.ip resolves to the edge IP and rate-limits collapse all
// users into one bucket. The "1" value trusts a single hop — never use "true"
// in production (would let any client forge X-Forwarded-For).
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const { isCorsOriginAllowed } = require('./lib/corsAllow');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isCorsOriginAllowed(origin)) {
    logger.warn('cors', null, 'origin rejected', { origin });
    return apiError(res, 403, 'CORS_FORBIDDEN', 'Origin not allowed');
  }
  return next();
});
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isCorsOriginAllowed(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'apikey',
    'x-orchestrator-secret',
    'x-webhook-secret',
    'paddle-signature',
    'Idempotency-Key',
  ],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(require('./lib/deprecatedWebhooks').deprecatedWebhooksMiddleware());
app.options('*', cors(corsOptions));

app.use((req, res, next) => {
  req.requestId = uuidv4();
  req.startTime = Date.now();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

app.use((req, res, next) => {
  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    if (duration > 5000) {
      logger.warn(req.path, null, 'Slow request', {
        duration_ms: duration,
        status: res.statusCode,
        request_id: req.requestId,
      });
    }
  });
  next();
});

// ─── Abuse pattern detector (sliding window per IP) ───────────────────────
// Catches credential probing, validation floods, route scanners,
// business-id enumeration, webhook-signature scanners. Logs warnings
// + fires Sentry events. Does NOT block requests — that's rate-limiter's
// job. See lib/abuseDetector.js.
const _abuseDetector = require('./lib/abuseDetector').createDetector({
  logger,
  sentry: process.env.SENTRY_DSN ? Sentry : null,
});
app.use(_abuseDetector.middleware);
setInterval(_abuseDetector.sweep, 5 * 60 * 1000).unref();

const paddleWebhookRawBody = express.raw({ type: 'application/json' });
let _paddleWebhookHandler = null;
function paddleWebhookEntry(req, res) {
  if (!_paddleWebhookHandler) {
    return res.status(503).json({ error: { code: 'BOOTING', message: 'Server still loading webhook routes' } });
  }
  return _paddleWebhookHandler(req, res);
}

// ─── Stripe webhook (parallel to Paddle — pick one or both per region) ──────
// MUST use raw body so signature verification can hash the exact bytes
// Stripe sent. The JSON parser is mounted AFTER this in the middleware chain.
const stripeWebhookRawBody = express.raw({ type: 'application/json' });
const stripeService = require('./services/stripe');
app.post('/webhook/stripe-webhook', stripeWebhookRawBody, async (req, res) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'STRIPE_WEBHOOK_SECRET not set' } });
  }
  const sig = req.headers['stripe-signature'];
  const rawBody = req.body;
  if (!sig || !Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Missing signature or raw body' } });
  }
  if (!stripeService.verifyStripeSignature(rawBody, sig, secret)) {
    logger.warn('/webhook/stripe-webhook', null, 'signature verification failed', { request_id: req.requestId });
    return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Could not parse body' } });
  }

  // Stripe idempotency + provisioning. Two-phase dedup (received → processed/
  // failed) with sbPatch+sbGet so a FAILED event is re-runnable on retry (not
  // silently swallowed by the PK). We provision SYNCHRONOUSLY and only ACK 200
  // on success — on failure we mark the event failed, evict the LRU, and return
  // 500 so Stripe retries. Previously we ACKed 200 before the async grant, so a
  // transient failure left a paying customer un-provisioned with no retry.
  const _webhookEvents = require('./lib/webhookEvents');
  if (event?.id) {
    const dedup = await _webhookEvents.markProcessed({
      provider: 'stripe',
      eventId: event.id,
      sbPost,
      sbPatch,
      sbGet,
      logger,
    });
    if (!dedup.firstTime) {
      logger.info('/webhook/stripe-webhook', null, 'duplicate event — skipping', { event_id: event.id });
      return res.json({ received: true, duplicate: true, request_id: req.requestId });
    }
  }

  try {
    const result = await stripeService.handleStripeEvent({
      event,
      sbGet,
      sbPatch,
      sbPost,
      sendEmail,
      logger,
      internalSecret: N8N_WEBHOOK_SECRET,
      port: process.env.PORT || 3000,
    });
    const ok = !result || result.ok !== false;
    if (event?.id) {
      await _webhookEvents
        .commitProcessed({
          provider: 'stripe',
          eventId: event.id,
          status: ok ? 'processed' : 'failed',
          sbPatch,
          logger,
          error: ok ? null : result?.error || 'handler returned ok:false',
        })
        .catch(() => {});
    }
    if (!ok) {
      if (event?.id) _webhookEvents.forgetEvent('stripe', event.id);
      return res.status(500).json({ error: { code: 'HANDLER_FAILED', message: 'event processing failed' } });
    }
    return res.json({ received: true, request_id: req.requestId });
  } catch (e) {
    logger.error('/webhook/stripe-webhook', null, 'handler error', { error: e.message });
    if (event?.id) {
      await _webhookEvents
        .commitProcessed({ provider: 'stripe', eventId: event.id, status: 'failed', sbPatch, logger, error: e.message })
        .catch(() => {});
      _webhookEvents.forgetEvent('stripe', event.id);
    }
    return res.status(500).json({ error: { code: 'HANDLER_ERROR', message: 'event processing error' } });
  }
});

// Paddle must register before express.json() so req.body stays a Buffer for HMAC.
app.post('/webhook/paddle-webhook', paddleWebhookRawBody, paddleWebhookEntry);

app.use(express.json({ limit: '10mb' }));

// ─── Distributed-tracing: request-correlation IDs ──────────────────────────
// Mount EARLY so every downstream handler can read req.requestId. Auto-tags
// Sentry breadcrumbs + response header (x-request-id) for end-to-end tracing.
const { requestIdMiddleware } = require('./lib/tracing');
app.use(requestIdMiddleware);

// ─── Security headers — HSTS / X-Frame-Options / CSP / etc. ───────────────
// Applied globally so even 404 + error responses get the headers. The
// status-page route opts into the more-permissive 'page' CSP profile via
// res.locals.cspMode = 'page'. See lib/securityHeaders.js.
const { securityHeaders } = require('./lib/securityHeaders');
app.use(securityHeaders({ env: process.env.NODE_ENV }));

// ─── Observability — metrics middleware (auto-tracks all HTTP requests) ──
const observability = require('./services/observability');
app.use(observability.metricsMiddleware());

// ─── Global baseline rate limit (DoS guard) ──────────────────────────────
// Permissive per-IP ceiling so a flood against any single route can't exhaust
// the process. Expensive AI/spend endpoints keep their own tighter limiter
// (aiRateLimit). Exempt: health/readiness/metrics probes, CORS preflight, and
// signature-verified payment webhooks (provider retry storms are legitimate).
const globalRateLimit = expressRateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.GLOBAL_RATE_LIMIT_PER_MIN || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests — please slow down' } },
  skip: (req) =>
    req.method === 'OPTIONS' ||
    req.path === '/' ||
    req.path === '/healthz' ||
    req.path === '/readyz' ||
    req.path === '/health' ||
    req.path === '/metrics' ||
    req.path === '/webhook/paddle-webhook' ||
    req.path === '/webhook/stripe-webhook',
});
app.use(globalRateLimit);

// ─── Config ───────────────────────────────────────────────────────────────────
// All values come from the validated `env` object (see lib/env.js). No prod-URL
// defaults — boot fails in lib/env.js if a required var is missing.
const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_KEY;
const ANTHROPIC_KEY = env.ANTHROPIC_KEY;
const SERPAPI_KEY = env.SERPAPI_KEY || '';
const REPLICATE_API_KEY = env.REPLICATE_API_KEY || '';
const PEXELS_API_KEY = env.PEXELS_API_KEY || '';
const RESEND_API_KEY = env.RESEND_API_KEY || '';
const FROM_EMAIL = env.FROM_EMAIL;
const OPENAI_API_KEY = env.OPENAI_API_KEY || '';
const PINECONE_API_KEY = env.PINECONE_API_KEY || '';
const PINECONE_HOST = env.PINECONE_HOST || '';
const RUNWAY_API_KEY = env.RUNWAY_API_KEY || '';
const GOOGLE_AI_API_KEY = env.GOOGLE_AI_API_KEY || '';
const TWILIO_ACCOUNT_SID = env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = env.TWILIO_WHATSAPP_FROM;
const PADDLE_WEBHOOK_SECRET = env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_STARTER_PRICE = env.PADDLE_STARTER_PRICE_ID || '';
const PADDLE_GROWTH_PRICE = env.PADDLE_GROWTH_PRICE_ID || '';
const PADDLE_AGENCY_PRICE = env.PADDLE_AGENCY_PRICE_ID || '';
const ORCHESTRATOR_SECRET = env.ORCHESTRATOR_SECRET || '';
const N8N_WEBHOOK_SECRET = env.N8N_WEBHOOK_SECRET;
const EXTERNAL_HTTP_TIMEOUT_MS = env.EXTERNAL_HTTP_TIMEOUT_MS;

// Paddle client initialized in services/paddle.js

function isInternalMaroaWebhookUrl(urlString) {
  try {
    const u = new URL(urlString);
    const p = u.pathname;
    if (p === '/webhook/paddle-webhook') return false;
    if (p === '/webhook/stripe-webhook') return false;
    if (!p.startsWith('/webhook/')) return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === 'maroa-api-production.up.railway.app';
  } catch {
    return false;
  }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
// Default timeout 15s. A 120s default lets one stuck call hold an Express
// worker hostage for two minutes — under load that turns into request
// starvation. Callers that legitimately need longer (Anthropic Opus streams,
// Higgsfield polls) pass an explicit override.
function apiRequest(method, url, headers = {}, body = null, timeoutMs = EXTERNAL_HTTP_TIMEOUT_MS, opts = {}) {
  const { allowInternalSecret = true } = opts;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const proto = u.protocol === 'https:' ? https : http;
    // Only attach the internal webhook secret to genuine loopback/self calls,
    // and never when the caller is fanning out to a customer-supplied URL — an
    // attacker could otherwise register the prod host as their webhook_url and
    // have the server call its own internal endpoints authenticated.
    const extra =
      allowInternalSecret && N8N_WEBHOOK_SECRET && isInternalMaroaWebhookUrl(url)
        ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET }
        : {};
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...extra, ...headers },
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        // Surface response headers so callers (externalHttp → retryWithJitter)
        // can honor Retry-After on 429/503 instead of only exponential backoff.
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
const sbH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

async function sbGet(table, query = '') {
  const r = await apiRequest('GET', `${SUPABASE_URL}/rest/v1/${table}?${query}`, sbH());
  if (r.status !== 200) throw new Error(`sbGet ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return Array.isArray(r.body) ? r.body : [];
}

async function sbPost(table, data) {
  const r = await apiRequest(
    'POST',
    `${SUPABASE_URL}/rest/v1/${table}`,
    { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    data
  );
  if (![200, 201].includes(r.status))
    throw new Error(`sbPost ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

async function sbPatch(table, filter, data) {
  const r = await apiRequest(
    'PATCH',
    `${SUPABASE_URL}/rest/v1/${table}?${filter}`,
    { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    data
  );
  if (![200, 201, 204].includes(r.status))
    throw new Error(`sbPatch ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return true;
}

async function sbDelete(table, filter) {
  const r = await apiRequest('DELETE', `${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    ...sbH(),
    Prefer: 'return=minimal',
  });
  if (![200, 201, 204, 404].includes(r.status))
    throw new Error(`sbDelete ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return true;
}

// ─── sbRpc — call plpgsql RPC functions (migration 071 + future) ──────────
// PostgREST exposes every function under /rest/v1/rpc/<name>. RPC bodies
// are keyword args matching the function's parameter names. Use this for
// atomic multi-table writes — see migrations/071_atomic_rpcs.sql.
async function sbRpc(fnName, args = {}) {
  const r = await apiRequest(
    'POST',
    `${SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(fnName)}`,
    { ...sbH(), 'Content-Type': 'application/json' },
    args || {}
  );
  if (r.status === 200 || r.status === 204) return r.body;
  if (r.status === 404) {
    // RPC doesn't exist — likely the migration that defines it hasn't been
    // applied yet. Surface a clear error so callers can fall back.
    const err = new Error(`sbRpc ${fnName}: 404 (function not found — run migrations?)`);
    err.code = 'RPC_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  throw new Error(`sbRpc ${fnName}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
}

// ─── Early listen — Railway healthcheck before the route table loads ────────
// listen() + /healthz first; remaining routes register in setImmediate below
// so health probes get event-loop time while server.js finishes loading.
const { registerHealthRoutes } = require('./lib/healthCheck');
const _openSockets = new Set();
const _sseClients = global._sseClients || (global._sseClients = new Set());

registerHealthRoutes({ app, sbGet, logger });

const server = app.listen(PORT, '0.0.0.0', () => {});

server.on('connection', (socket) => {
  _openSockets.add(socket);
  socket.on('close', () => _openSockets.delete(socket));
});

server.on('listening', () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Maroa.ai API v2.0 — port :${PORT}`);
  console.log(`  Layer 1: Execution ✓  Layer 2: Intelligence ✓  Layer 3: Learning ✓`);
  // External-write gating visibility (audit fix): show whether the system will
  // actuate ads / publish for real, or run dry. Never block boot on a log line.
  try {
    console.log(`  ${require('./lib/env').liveFlagsLogLine(env)}`);
  } catch {
    /* diagnostic only */
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log('[boot] listening — loading routes (/healthz ready)');

  setImmediate(() => {
    require('./lib/startupSelfTest')
      .runStartupSelfTest({ sbGet, logger })
      .catch((e) => logger.error('startup-self-test', null, 'self-test crashed', e));
  });
});

// Defer route registration so /healthz can respond while ~10k lines of requires run.
const _routeLoadStartedAt = Date.now();
setImmediate(() => {
  // SLO monitor: every 60s, evaluate the SLO catalog against live metrics
  // and route violations to Sentry + Slack + Email + PagerDuty (per severity)
  // via the alert router. No-op in tests (NODE_ENV=test).
  // See services/observability/slos.js + lib/alertRouter.js.
  const internalDispatcher = require('./lib/internalDispatcher');
  {
    const { createAlertRouter } = require('./lib/alertRouter');
    // sendEmail is the existing utility loaded earlier in this file (search
    // for `function sendEmail` or `const sendEmail`). It might or might not
    // be defined yet at this point in module load — pass a thunk so it's
    // resolved at alert time, not boot time.
    const _alertRouter = createAlertRouter({
      sendEmail: async (to, subject, html) => {
        if (typeof sendEmail === 'function') return sendEmail(to, subject, html);
        return { sent: false, reason: 'sendEmail not yet bound' };
      },
      logger,
    });
    require('./services/observability/slos').startSloMonitor({ router: _alertRouter });

    // Wave 59 S5: quarterly taxonomy refresh — registered with the internal
    // dispatcher so the Inngest cron can invoke it without an HTTP round-trip.
    // No public HTTP route — this is internal-only.
    const taxonomyRefresh = require('./services/taxonomy-refresh');
    internalDispatcher.register('/webhook/taxonomy-refresh-run', async () =>
      taxonomyRefresh.refreshTaxonomy({
        deps: { callClaude, alertRouter: _alertRouter, logger },
      })
    );
  }

  const path = require('path');
  const fs = require('fs');
  app.get('/docs/openapi.yml', (req, res) => {
    const specPath = path.join(__dirname, 'docs', 'openapi.yml');
    if (!fs.existsSync(specPath)) return res.status(404).type('text/plain').send('openapi spec not found');
    res.type('application/yaml').send(fs.readFileSync(specPath, 'utf8'));
  });

  // ─── /metrics + /webhook/cost-report (carved into routes/observability.js) ─
  // First carve-out from server.js. See routes/observability.js for the
  // pattern that the rest of the server.js → routes/*.js extraction will
  // follow over the next sprint.
  const { requireMetricsAuth } = require('./middleware/requireMetricsAuth');
  require('./routes/observability').register({ app, observability, sbGet, apiError, requireMetricsAuth });
  require('./routes/status-page').register({ app });

  // Constant-time string compare. Returns false on length mismatch without
  // leaking which side was longer. Use for every secret / signature compare.
  function timingSafeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) {
      // Compare against self to keep work proportional and avoid early-exit timing.
      crypto.timingSafeEqual(ab, ab);
      return false;
    }
    return crypto.timingSafeEqual(ab, bb);
  }

  const { requireAuthOrWebhookSecret } = require('./middleware/requireAuthOrWebhookSecret');
  const { assertBusinessOwnerMiddleware } = require('./lib/assertBusinessOwner');
  app.use('/webhook', requireAuthOrWebhookSecret);
  app.use('/webhook', assertBusinessOwnerMiddleware({ sbGet, apiError, logger }));
  app.use('/api/business', assertBusinessOwnerMiddleware({ sbGet, apiError, logger }));
  // Param-aware mounts: at the bare '/api/business' mount above, Express does
  // NOT populate req.params.businessId, so :businessId routes (llm-spend,
  // brand-voice, integrations, monthly-report, marketing-deep-dive,
  // email-lifecycle) were unguarded — any JWT could read/act on any tenant by
  // changing the UUID in the URL. These mounts populate the param so the owner
  // check actually fires. Same for /api/cron-health/:businessId.
  app.use('/api/business/:businessId', assertBusinessOwnerMiddleware({ sbGet, apiError, logger }));
  app.use('/api/cron-health/:businessId', assertBusinessOwnerMiddleware({ sbGet, apiError, logger }));

  const aiLimitExpress = expressRateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests — please wait' },
  });

  function aiRateLimit(req, res, next) {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      // Key on the JWT-verified user id, never body fields: a client could send
      // a fresh random userId/business_id per request to get a new bucket each
      // time, defeating the limit. Fall back to the real client IP (trust
      // proxy=1 makes req.ip the actual client behind Railway's proxy).
      const id = String(req.user?.id || req.ip || 'anon');
      return checkRateLimit(id)
        .then((out) => {
          if (out.degraded) {
            // checkRateLimit fails open ({success:true, degraded:true}) when
            // Upstash is down/slow so bare awaits elsewhere never hang. Here
            // we must NOT accept that open-pass: fail closed onto the
            // in-process limiter instead — an Upstash blip must not uncap the
            // expensive (LLM/image/video) endpoints, especially since
            // costGuard also soft-fails open during a correlated outage.
            logger.warn(req.path, null, 'Rate limiter degraded — falling back to in-process limiter', {
              request_id: req.requestId,
              reason: out.reason || null,
            });
            return aiLimitExpress(req, res, next);
          }
          if (!out.success) {
            return apiError(res, 429, 'RATE_LIMITED', 'Too many requests — please wait 1 minute');
          }
          next();
        })
        .catch((e) => {
          // Belt-and-braces: checkRateLimit's contract is never-reject, but if
          // that ever regresses, still fail closed onto the in-process limiter.
          logger.warn(req.path, null, 'Redis rate limit check failed — falling back to in-process limiter', {
            request_id: req.requestId,
            error: e.message,
          });
          return aiLimitExpress(req, res, next);
        });
    }
    return aiLimitExpress(req, res, next);
  }

  app.use('/api/ideas', aiRateLimit);
  app.use('/api/lead-magnets', aiRateLimit);
  app.use('/api/research', aiRateLimit);
  app.use('/api/sales', aiRateLimit);
  app.use('/api/community', aiRateLimit);
  app.use('/api/pricing', aiRateLimit);
  app.use('/api/schema', aiRateLimit);
  app.use('/api/ai-seo', aiRateLimit);

  // Expensive AI webhooks — per-business/user throttle to protect API credit.
  app.use('/webhook/content-generate', aiRateLimit);
  app.use('/webhook/video-script-generate', aiRateLimit);
  app.use('/webhook/video-generate-runway', aiRateLimit);
  app.use('/webhook/master-agent', aiRateLimit);
  app.use('/webhook/ai-brain-run', aiRateLimit);
  app.use('/webhook/agency-generate', aiRateLimit); // Wave 60 master pipeline

  // ─── Cost guard — per-business monthly $ cap on LLM endpoints ───────────────
  // Mounted on the same paths as aiRateLimit (any route that spends real
  // Anthropic dollars). Rate limit prevents spike-of-requests; cost guard
  // prevents a single customer from grinding through their monthly cap on
  // expensive long prompts.
  //
  // Soft-fail in costGuard means a Supabase outage allows the request rather
  // than 402-ing every customer simultaneously. Real abuse still gets blocked.
  const { costGuardMiddleware } = require('./lib/costGuard');
  const costGuard = costGuardMiddleware({ sbGet });
  app.use('/api/ideas', costGuard);
  app.use('/api/lead-magnets', costGuard);
  // Audit 2026-05-20 P1-1: /api/content/generate (the magic-moment + Generate
  // Now path) is the most expensive route per call — full grounding + variants
  // + critic. Add costGuard so a misconfigured customer can't blow past their
  // plan cap. aiRateLimit too — same 60s window as the other AI routes.
  app.use('/api/content/generate', aiRateLimit);
  app.use('/api/content/generate', costGuard);
  app.use('/api/research', costGuard);
  app.use('/api/sales', costGuard);
  app.use('/api/community', costGuard);
  app.use('/api/pricing', costGuard);
  app.use('/api/schema', costGuard);
  app.use('/api/ai-seo', costGuard);
  app.use('/api/strategy', costGuard);
  app.use('/api/onboarding-cro', costGuard);
  app.use('/webhook/content-generate', costGuard);
  app.use('/webhook/video-script-generate', costGuard);
  app.use('/webhook/master-agent', costGuard);
  app.use('/webhook/ai-brain-run', costGuard);
  app.use('/webhook/cold-start-trigger', costGuard);
  app.use('/webhook/instant-content', costGuard);
  app.use('/webhook/agency-generate', costGuard); // Wave 60 master pipeline

  // Body-shape validation for critical webhooks.
  app.use('/webhook/instant-content', zodValidate(businessIdBody));
  app.use('/webhook/content-approved', zodValidate(businessIdBody));
  app.use('/webhook/competitor-check', zodValidate(businessIdBody));
  app.use('/api/ideas/generate', requireValidUserId);
  app.use('/api/lead-magnets/generate', requireValidUserId);
  app.use('/api/research/analyze', requireValidUserId);
  app.use('/api/pricing/analyze', requireValidUserId);
  app.use('/api/schema/generate', requireValidUserId);
  app.use('/api/ai-seo/optimize', requireValidUserId);
  app.use('/api/sales/generate-pitch', requireValidUserId);
  app.use('/api/community/generate-posts', requireValidUserId);
  app.use('/api/campaigns/instant', requireValidUserId);
  app.use('/api/content/repurpose', requireValidUserId);
  app.use('/api/compete/counter', requireValidUserId);
  app.use('/api/reviews/auto-respond', requireValidUserId);
  app.use('/api/referral/setup', requireValidUserId);
  app.use('/api/signup-cro/analyze', requireValidUserId);
  app.use('/api/higgsfield/train-soul', requireValidUserId);

  // Auth guard for routes that use user_id/userId.
  // Closes the IDOR risk surfaced in the 2026-05-13 audit: previously the
  // fallback path accepted any well-formed UUID without ownership verification.
  // Now requires a Bearer JWT (verified via Supabase admin) and refuses when
  // the request's userId disagrees with the token's user.id.
  // Legacy UUID-only access is gated behind LEGACY_USERID_FALLBACK_ALLOWED.
  // See middleware/authenticateUserId.js for the full contract.
  const { makeAuthenticateUserId } = require('./middleware/authenticateUserId');
  function _supabaseAdminGetUser(token) {
    const { createClient } = require('@supabase/supabase-js');
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
    const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return Promise.resolve({ data: null, error: new Error('auth_not_configured') });
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return admin.auth.getUser(token);
  }
  const requireAnyUserId = makeAuthenticateUserId({
    supabaseAdminGetUser: _supabaseAdminGetUser,
    metrics: observability && observability.metrics,
    env: process.env,
    apiError,
  });
  app.use('/api/onboarding/save', requireAnyUserId);
  app.use('/api/onboarding/profile', requireAnyUserId);
  app.use('/api/onboarding/score', requireAnyUserId);
  app.use('/api/checkout', requireAnyUserId);
  app.use('/api/intelligence', requireAnyUserId);
  app.use('/api/opportunities', requireAnyUserId);
  app.use('/api/metrics', requireAnyUserId);
  app.use('/api/performance', requireAnyUserId);
  app.use('/api/health', requireAnyUserId);
  // Audit 2026-05-20 P0-6: list endpoints (/api/ideas/:userId,
  // /api/lead-magnets/:userId) need auth too — not just /generate.
  // Must be after requireAnyUserId declaration above.
  app.use('/api/ideas', requireAnyUserId);
  app.use('/api/lead-magnets', requireAnyUserId);
  app.use('/api/strategy', requireAnyUserId);
  app.use('/api/context', requireAnyUserId);
  app.use('/api/orchestrator', requireAnyUserId);
  app.use('/api/calendar', requireAnyUserId);
  app.use('/api/content/feedback', requireAnyUserId);
  app.use('/api/ab-tests', requireAnyUserId);
  app.use('/api/tools', requireAnyUserId);
  app.use('/api/popup', requireAnyUserId);
  app.use('/api/onboarding-cro', requireAnyUserId);
  app.use('/api/upgrade', requireAnyUserId);
  app.use('/api/revops', requireAnyUserId);
  app.use('/api/referral', requireAnyUserId);
  app.use('/api/launch', requireAnyUserId);
  app.use('/api/seo-pages', requireAnyUserId);
  app.use('/api/social', requireAnyUserId);

  // ─── Audit fix 2026-05-14 — gaps caught by tests/route-auth-registry.test.js ───
  // These prefixes had inline route definitions that bypassed both auth
  // mounts. The route-auth-registry test fails if any /api/* route doesn't
  // classify into an auth tier. With LEGACY_USERID_FALLBACK_ALLOWED=1
  // during the transition, existing callers continue working; once the
  // flag is flipped off these become strict JWT.
  app.use('/api/content', requireAnyUserId); // /api/content/generate, /api/content/feedback, /api/content/repurpose
  app.use('/api/cron-health', requireAnyUserId); // /api/cron-health/:businessId
  app.use('/api/business', requireAnyUserId); // /api/business/:businessId/brand-voice
  app.use('/api/ops', requireAnyUserId); // /api/ops/platform
  app.use('/api/generate', requireAnyUserId); // /api/generate
  app.use('/api/schema', requireAnyUserId); // /api/schema/:userId (READ side of schema)
  app.use('/api/pricing', requireAnyUserId); // /api/pricing/:userId (READ side of pricing)
  app.use('/api/sales', requireAnyUserId); // /api/sales/objection-handler + future siblings

  // ─── Stream tickets — EventSource auth for the SSE routes ────────────────
  // Browsers cannot attach an Authorization header to an EventSource, so the
  // dashboard mints a short-lived signed ticket here (JWT-authed) and appends
  // it as ?ticket= on GET /webhook/dashboard-events + /webhook/wf15-stream/:id.
  // Verify side lives in middleware/requireAuthOrWebhookSecret.js.
  app.use('/api/stream-ticket', requireAnyUserId);
  require('./routes/stream-ticket').register({ app, sbGet, apiError, logger, env });

  // ─── Tenant isolation on /api/* routes that act on a business_id ──────────
  // requireAnyUserId proves the JWT matches the supplied userId, but NOT that
  // the user may act on the business_id in the request body. Without this gate
  // any authenticated user could generate content / spend budget against another
  // tenant by passing a victim's business_id (IDOR). Mounted after the auth
  // middleware above so req.user is populated. The gate is a no-op when no
  // business_id is present, and is workspace-aware so agency members keep access
  // to their client businesses (see lib/assertBusinessOwner.js).
  const _ownerGate = assertBusinessOwnerMiddleware({ sbGet, apiError, logger });
  app.use('/api/content', _ownerGate);
  app.use('/api/generate', _ownerGate);
  app.use('/api/social', _ownerGate);
  app.use('/api/seo-pages', _ownerGate);

  // ─── Idempotency-Key middleware on mutating customer-facing routes ────────
  // Browser retries on a transient blip can double-fire mutations: content
  // posts twice, ad spend doubles, email enrolments duplicate. Idempotency-Key
  // header (Stripe/GitHub convention) caches the response by (route,userId,key)
  // for 24h. webhook routes have their own (provider,event_id) dedup —
  // exempt. middleware/idempotency.js + migration 069.
  //
  // Currently `optional` so existing clients without the header continue
  // working. Promote to `required` after CLAUDE.md change announcement and
  // frontend rollout. Track adoption via the idempotency_key_required_total
  // metric.
  const { makeIdempotency } = require('./middleware/idempotency');
  const _idempotency = makeIdempotency({ sbGet, sbPost, sbPatch, logger });

  // Compliance gate — wraps lib/complianceEngine in a single ensureCompliant()
  // that throws ComplianceBlocked on hard violations. Wired into publish routes
  // + /api/content/generate so disallowed claims (FTC income guarantees, FDA
  // medical claims, etc.) never reach the platform or the customer's draft.
  const { ensureCompliant: _ensureCompliant, ComplianceBlocked: _ComplianceBlocked } = require('./lib/complianceGate');
  app.use('/api/content/publish', _idempotency.optional);
  app.use('/api/content/generate', _idempotency.optional);
  app.use('/api/social', _idempotency.optional);
  app.use('/api/ad-campaigns', _idempotency.optional);
  app.use('/api/email-lifecycle', _idempotency.optional);
  app.use('/api/launch', _idempotency.optional);
  app.use('/api/generate', _idempotency.optional);

  // ─── Universal decision logger (lib/decisionLog) ────────────────────────
  // Constructed here (above all agent factories) so every service that
  // wants to mirror into decision_logs can take a single shared instance.
  // Soft-fail: if the lib or migration 065 isn't ready, all agents skip
  // the mirror silently.
  const _decisionLog = (() => {
    try {
      const { makeDecisionLogger } = require('./lib/decisionLog');
      return makeDecisionLogger({ sbGet, sbPost, sbPatch, logger: typeof logger !== 'undefined' ? logger : null });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[decisionLog] failed to construct:', e.message);
      return null;
    }
  })();

  const PLAN_TOKEN_BUDGETS = {
    starter: { daily_tokens: 200000, max_tokens_per_call: 4000, calls_per_day: 100 },
    growth: { daily_tokens: 500000, max_tokens_per_call: 6000, calls_per_day: 200 },
    agency: { daily_tokens: 1000000, max_tokens_per_call: 8000, calls_per_day: 500 },
  };

  function normalizePlanTier(plan) {
    const p = (plan || 'free').toLowerCase();
    if (p === 'agency') return 'agency';
    if (p === 'growth') return 'growth';
    return 'starter';
  }

  async function sbCountExact(table, queryWithoutSelect) {
    return new Promise((resolve, reject) => {
      if (!SUPABASE_KEY) return resolve(0);
      const path = `/rest/v1/${table}?${queryWithoutSelect}&select=id`;
      const url = new URL(SUPABASE_URL + path);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'GET',
          headers: { ...sbH(), Prefer: 'count=exact' },
        },
        (res) => {
          res.resume();
          const cr = res.headers['content-range'];
          const m = typeof cr === 'string' && cr.match(/\/(\d+)\s*$/);
          resolve(m ? parseInt(m[1], 10) : 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function checkTokenBudgetForBusiness(businessId) {
    if (!businessId || !SUPABASE_KEY) return { allowed: true, maxTokensPerCall: 4000 };
    // Rule 4 (CLAUDE.md): encode PostgREST filter inputs. businessId here is
    // server-internal — pulled from a JWT-validated request — but encoding is
    // cheap insurance against future callers who skip validation.
    const safeBiz = encodeURIComponent(String(businessId));
    try {
      let rows = await sbGet('businesses', `id=eq.${safeBiz}&select=plan,user_id`).catch(() => []);
      if (!rows.length) rows = await sbGet('businesses', `user_id=eq.${safeBiz}&select=plan,user_id`).catch(() => []);
      if (!rows.length) return { allowed: true, maxTokensPerCall: 2000 };
      const tier = normalizePlanTier(rows[0]?.plan);
      const budget = PLAN_TOKEN_BUDGETS[tier] || PLAN_TOKEN_BUDGETS.starter;
      const logUid = rows[0]?.user_id || businessId;

      // ─── Atomic budget reservation via Upstash Redis ─────────────────────
      // Fixes the race-condition flagged in ADR-0004 #7. Redis INCR is
      // atomic — N concurrent requests cannot all slip past the limit.
      // Returns mode='legacy' when Upstash isn't configured, in which
      // case we fall through to the original orchestration_logs check.
      const { reserveBudgetSlot } = require('./lib/budgetCounter');
      const slot = await reserveBudgetSlot({ businessId: logUid, budget });
      if (slot.mode === 'atomic' || slot.mode === 'redis_error') {
        // Authoritative path — Redis told us yes or no. Trust it.
        if (!slot.allowed) {
          return {
            allowed: false,
            reason: slot.reason || `Daily limit of ${budget.calls_per_day} AI calls reached for ${tier} plan`,
            maxTokensPerCall: budget.max_tokens_per_call,
          };
        }
        return { allowed: true, maxTokensPerCall: budget.max_tokens_per_call };
      }

      // mode === 'legacy' — fall back to the racy check-then-act path.
      // Acceptable when Upstash isn't configured because the dollar-cap
      // in lib/costGuard still bounds total spend per business.
      const since = new Date(Date.now() - 86400000).toISOString();
      const count = await sbCountExact(
        'orchestration_logs',
        `user_id=eq.${logUid}&created_at=gte.${encodeURIComponent(since)}&task=eq.ai_call`
      );
      if (count >= budget.calls_per_day) {
        return {
          allowed: false,
          reason: `Daily limit of ${budget.calls_per_day} AI calls reached for ${tier} plan`,
          maxTokensPerCall: budget.max_tokens_per_call,
        };
      }
      return { allowed: true, maxTokensPerCall: budget.max_tokens_per_call };
    } catch {
      return { allowed: true, maxTokensPerCall: 2000 };
    }
  }

  /** Pass-through for plan token budgets + ai_call logging (businessId resolves via businesses id or user_id). */
  function claudeBiz(userId) {
    return userId ? { businessId: String(userId) } : {};
  }

  // ─── Claude model selection & API ───────────────────────────────────────────
  function selectModel(taskType) {
    if (['strategy', 'monthly_review', 'positioning', 'research', 'orchestrator'].includes(taskType)) {
      return { model: 'claude-opus-4-7', max_tokens: 4000 };
    }
    if (['social_post', 'email', 'campaign', 'paid_ad', 'sales_pitch'].includes(taskType)) {
      return { model: 'claude-sonnet-4-6', max_tokens: 2000 };
    }
    if (['caption', 'idea', 'hashtags', 'short_copy', 'community_post'].includes(taskType)) {
      return { model: 'claude-haiku-4-5', max_tokens: 1000 };
    }
    return { model: 'claude-sonnet-4-6', max_tokens: 2000 };
  }

  // ─── Brand-voice auto-load support ──────────────────────────────────────────
  // Skills marked as "content" trigger automatic brand-voice anchor injection
  // into the Claude system prompt. Everything else (audits, classification,
  // internal scoring) stays voice-neutral so we don't confuse the model.
  const _CONTENT_SKILLS = new Set([
    'social_post',
    'caption',
    'long_form',
    'blog',
    'email',
    'email_subject',
    'instagram_caption',
    'facebook_post',
    'linkedin_post',
    'twitter_post',
    'tiktok_video_script',
    'youtube_short_caption',
    'pinterest_pin',
    'ad_copy',
    'hero_rewrite',
    'cta',
    'value_prop',
    'cro_rewrite',
    'creative_concept',
    'creative_brief',
    'monthly_review',
    'weekly_scorecard_narrative',
    'scorecard_text',
    'voc_synthesis',
    'ai_seo_page',
  ]);
  function _isContentSkill(skill) {
    if (!skill) return false;
    return _CONTENT_SKILLS.has(String(skill));
  }

  const _brandVoiceCache = new Map(); // businessId → { block, expiresAt }
  const _BRAND_VOICE_TTL_MS = 5 * 60 * 1000;
  async function _loadBrandVoiceBlock(businessId) {
    const cached = _brandVoiceCache.get(businessId);
    if (cached && cached.expiresAt > Date.now()) return cached.block;

    const rows = await sbGet(
      'business_profiles',
      `user_id=eq.${encodeURIComponent(businessId)}&select=brand_voice_anchor`
    ).catch(() => []);
    let anchor = rows?.[0]?.brand_voice_anchor || null;
    if (!anchor) {
      // Fall back to building one synchronously from the businesses row
      const bizRows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=*`).catch(() => []);
      const business = bizRows?.[0];
      if (business) {
        try {
          anchor = require('./services/prompts/brand-voice').buildAnchor({ business });
        } catch {
          /* brand-voice module not loadable in this env */
        }
      }
    }
    let block = '';
    if (anchor) {
      try {
        block = require('./services/prompts/brand-voice').formatAnchorForPrompt(anchor);
      } catch {
        /* soft-fail */
      }
    }
    _brandVoiceCache.set(businessId, { block, expiresAt: Date.now() + _BRAND_VOICE_TTL_MS });
    return block;
  }

  /**
   * Call Claude. Backward compatible:
   * - callClaude(prompt, 'claude-opus-4-7', 3000) — explicit model
   * - callClaude(prompt, 'strategy', 1500) — taskType + optional max override
   * - callClaude(prompt, 'social_post', undefined, { returnRaw: true, system: '...' })
   *
   * Auto-features when extra.businessId is provided:
   *   - cost tracking via observability.costTracker.track()
   *   - per-business token budget (extra.skipBudget to opt out)
   *   - brand-voice anchor auto-injection for content-type skills
   *     (extra.skipBrandVoice to opt out)
   */
  async function callClaude(prompt, taskTypeOrModel = 'social_post', maxTokensOverride, extra = {}) {
    // ─── Object-shape support ─────────────────────────────────────────────
    // Many newer prompt modules (services/prompts/{ad-optimizer, cro, ai-seo,
    // voc, ...}) invoke callClaude with the shape
    //   callClaude({ system, user, model, max_tokens, extra })
    // Without this adapter those calls would stringify the object as the user
    // message and silently bypass the system prompt + cache + advisor wiring.
    if (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) {
      const obj = prompt;
      prompt = obj.user;
      if (obj.model) taskTypeOrModel = obj.model;
      else if (obj.taskType) taskTypeOrModel = obj.taskType;
      if (obj.max_tokens !== undefined) maxTokensOverride = obj.max_tokens;
      if (obj.maxTokens !== undefined) maxTokensOverride = obj.maxTokens;
      const composed = { ...(obj.extra || {}) };
      if (obj.system !== undefined && composed.system === undefined) composed.system = obj.system;
      if (obj.businessId && composed.businessId === undefined) composed.businessId = obj.businessId;
      if (obj.skill && composed.skill === undefined) composed.skill = obj.skill;
      // Object-shape callers (services/prompts/*) call extractJSON on the
      // result themselves, so default returnRaw=true. They can override.
      if (composed.returnRaw === undefined && composed.returnFullResponse === undefined) {
        composed.returnRaw = true;
      }
      extra = composed;
    }

    if (
      maxTokensOverride !== undefined &&
      typeof maxTokensOverride === 'object' &&
      maxTokensOverride !== null &&
      !Array.isArray(maxTokensOverride)
    ) {
      extra = maxTokensOverride;
      maxTokensOverride = undefined;
    }
    let model;
    let maxTokens;
    if (typeof taskTypeOrModel === 'string' && taskTypeOrModel.startsWith('claude-')) {
      model = taskTypeOrModel;
      maxTokens = maxTokensOverride !== undefined ? maxTokensOverride : 2000;
    } else {
      const sel = selectModel(taskTypeOrModel || 'social_post');
      model = extra.model || sel.model;
      maxTokens = maxTokensOverride !== undefined ? maxTokensOverride : sel.max_tokens;
    }

    if (extra.businessId && !extra.skipBudget) {
      const { enforceLLMBudget } = require('./lib/llmGateway');
      const budget = await enforceLLMBudget({
        businessId: extra.businessId,
        sbGet,
        checkTokenBudgetForBusiness,
        skipCostCap: !!extra.skipCostCap,
      });
      maxTokens = Math.min(maxTokens, budget.maxTokensPerCall || maxTokens);
    }

    // ─── Brand-voice auto-load ────────────────────────────────────────────
    // For any call with a businessId AND a customer-facing skill, prepend the
    // brand_voice_anchor (cached 5 min) to the system prompt. Customers
    // previously needed every caller to remember to apply brand voice manually;
    // now it's automatic for content-type skills.
    //
    // Opt-out: pass extra.skipBrandVoice = true (e.g. internal classification
    // calls that shouldn't be voice-locked).
    if (extra.businessId && !extra.skipBrandVoice && _isContentSkill(extra.skill)) {
      try {
        const anchorBlock = await _loadBrandVoiceBlock(extra.businessId);
        if (anchorBlock) {
          extra = { ...extra, system: anchorBlock + '\n\n' + (extra.system || '') };
        }
      } catch {
        // Brand voice is a nice-to-have — never block a Claude call on its absence.
      }
    }

    // Industry benchmarks + performance grounding for every business-scoped Claude call.
    if (extra.businessId && !extra.skipGrounding && !Array.isArray(extra.systemBlocks)) {
      try {
        const groundingLib = require('./lib/groundingContext');
        const skill = String(extra.skill || taskTypeOrModel || '');
        const surface =
          extra.groundingSurface ||
          (skill.includes('ad_optimizer') || skill.includes('wf3') || skill.includes('audit')
            ? 'ad_copy'
            : skill.includes('email')
              ? 'email'
              : skill.includes('seo')
                ? 'seo'
                : skill.includes('cro') || skill.includes('landing')
                  ? 'landing_page'
                  : 'social_post');
        const gCtx = await groundingLib.buildGroundingContext({
          sbGet,
          businessId: extra.businessId,
          surface,
          intent: extra.groundingIntent || 'conversion',
          plan: extra.plan,
          semanticQuery: extra.semanticQuery,
          clientMetrics: extra.clientMetrics,
          limit: 3,
        });
        const gBlock = gCtx.toPromptBlock();
        if (gBlock) {
          extra = { ...extra, system: (extra.system ? `${extra.system}\n\n` : '') + gBlock };
        }
      } catch (gErr) {
        log('callClaude', `grounding inject failed (non-fatal): ${gErr.message}`);
      }
    }

    // Build user message content. Default = single text block from `prompt`.
    // If extra.fileIds, extra.documentBlocks, or extra.imageBlocks are provided,
    // prepend them as content blocks (Files API + Citations support).
    let userContent;
    const docBlocks = [];
    for (const fileId of extra.fileIds || []) {
      const blk = { type: 'document', source: { type: 'file', file_id: fileId } };
      if (extra.citations) blk.citations = { enabled: true };
      if (extra.cacheDocuments) blk.cache_control = { type: 'ephemeral' };
      docBlocks.push(blk);
    }
    for (const dblk of extra.documentBlocks || []) docBlocks.push(dblk);
    for (const iblk of extra.imageBlocks || []) docBlocks.push(iblk);
    userContent = docBlocks.length === 0 ? prompt : [...docBlocks, { type: 'text', text: prompt }];

    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: userContent }] };

    // Anthropic prompt caching — three shapes accepted (Wave 59 S2):
    //
    //   1. extra.systemBlocks: array of {type:'text', text:'...', cache_control?:...}
    //      Fine-grained: caller decides which segments to cache. Used by the
    //      closed-loop creative system (grounding library → toCacheableBlocks)
    //      so the corpus block caches independently of customer-specific context.
    //
    //   2. extra.system + extra.cacheSystem:true: legacy single-segment shape.
    //      Wraps the entire system prompt in one cache_control block.
    //
    //   3. extra.system (string only): no caching.
    //
    // Anthropic caches segments with cache_control set, with a 5-min TTL.
    // First call pays full price; subsequent calls within window pay 10%.
    if (Array.isArray(extra.systemBlocks) && extra.systemBlocks.length) {
      body.system = extra.systemBlocks
        .filter((b) => b && b.text && String(b.text).trim())
        .map((b) => ({
          type: 'text',
          text: String(b.text),
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        }));
    } else if (extra.system) {
      if (extra.cacheSystem) {
        const { cacheControlBlock } = require('./lib/claudeAnthropicTools');
        body.system = [
          {
            type: 'text',
            text: extra.system,
            cache_control: cacheControlBlock(extra.cacheTtl === '1h' ? '1h' : undefined),
          },
        ];
      } else {
        body.system = extra.system;
      }
    }

    const { attachToolsToBody } = require('./lib/claudeAnthropicTools');
    if (extra.advisor || extra.webSearch || extra.codeExecution) {
      attachToolsToBody(body, {
        advisor: extra.advisor
          ? { model: extra.advisor.model || 'claude-opus-4-7', maxUses: extra.advisor.max_uses || 3 }
          : null,
        webSearch: extra.webSearch
          ? {
              maxUses: extra.webSearch.max_uses || 5,
              dynamicFilter: !!extra.webSearch.dynamicFilter,
            }
          : null,
        codeExecution: extra.codeExecution || null,
      });
    }

    const { buildDiagnosticsPayload, ingestResponse } = require('./lib/cacheDiagnostics');
    const diagnostics = buildDiagnosticsPayload({
      businessId: extra.businessId,
      skill: extra.skill,
      enable: !!(extra.cacheSystem || extra.systemBlocks),
    });
    if (diagnostics) body.diagnostics = diagnostics;

    const headers = {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
    const betas = [];
    const _systemBlocksHaveCache =
      Array.isArray(extra.systemBlocks) && extra.systemBlocks.some((b) => b && b.cache_control);
    if (extra.cacheSystem || extra.cacheDocuments || _systemBlocksHaveCache) {
      betas.push('prompt-caching-2024-07-31');
    }
    if ((extra.fileIds && extra.fileIds.length) || extra.documentBlocks?.some?.((b) => b?.source?.type === 'file'))
      betas.push('files-api-2025-04-14');
    if (extra.extraBetas) betas.push(...(Array.isArray(extra.extraBetas) ? extra.extraBetas : [extra.extraBetas]));
    if (extra.webSearch?.dynamicFilter || extra.codeExecution) {
      betas.push('code-execution-2025-08-25');
    }
    if (betas.length) headers['anthropic-beta'] = [...new Set(betas)].join(',');

    // Retry policy: `extra.retries` is total attempts (default 3). retryWithJitter
    // takes "additional retries after first try", so we pass retries-1. Each attempt
    // goes through the anthropic circuit breaker so persistent degradation trips
    // it and fast-fails the next callers instead of stacking 45s waits.
    const totalAttempts = extra.retries !== undefined ? extra.retries : 3;
    const ANTHROPIC_TIMEOUT_MS = SERVICE_TIMEOUTS_MS.timeoutForHost('api.anthropic.com');

    let r;
    try {
      r = await retryWithJitter(
        () =>
          fireBreaker('anthropic', async () => {
            // eslint-disable-next-line no-restricted-syntax -- this IS callClaude's implementation
            const resp = await apiRequest(
              'POST',
              'https://api.anthropic.com/v1/messages',
              headers,
              body,
              ANTHROPIC_TIMEOUT_MS
            );
            // The breaker should only "see" failures that indicate provider
            // degradation (429, 5xx, network). Caller-side errors (401, 403,
            // 404, 400) must NOT trip it — they're the caller's bug. Return
            // those as a "success" from the breaker's POV; we throw outside.
            if (resp.status >= 200 && resp.status < 400) return resp;
            if (resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500) {
              const err = new Error(`Claude ${model}: ${resp.status} ${JSON.stringify(resp.body).slice(0, 200)}`);
              err.status = resp.status;
              err._response = resp;
              throw err;
            }
            // 4xx caller errors — return so breaker stays clean; throw below.
            return resp;
          }),
        {
          retries: Math.max(0, totalAttempts - 1),
          baseDelayMs: 1_000,
          maxDelayMs: 20_000,
          onRetry: ({ attempt, delayMs, err }) => {
            logger.warn('/claude', extra.businessId || null, `Claude retry ${attempt}/${totalAttempts - 1}`, {
              status: err?.status || null,
              error: err?.message?.slice(0, 200),
              delay_ms: delayMs,
            });
          },
        }
      );
    } catch (e) {
      if (e && e.isCircuitOpen) {
        // Anthropic breaker is open — surface as 503 to caller, don't burn budget.
        const wrapped = new Error('anthropic_circuit_open');
        wrapped.status = 503;
        wrapped.code = 'ANTHROPIC_CIRCUIT_OPEN';
        wrapped.cooldownMs = e.cooldownMs;
        throw wrapped;
      }
      throw e;
    }

    // Non-2xx caller-side errors: throw here so the breaker stayed clean.
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`Claude ${model}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }

    if (extra.businessId && !extra.skipUsageLog) {
      setImmediate(() => {
        sbGet('businesses', `id=eq.${encodeURIComponent(extra.businessId)}&select=user_id`)
          .then((rows) => {
            const uid = rows[0]?.user_id || extra.businessId;
            return recordOrchestrationTaskRun(uid, 'ai_call');
          })
          .catch(() => {});
      });
    }
    if (extra.businessId || extra.skill) {
      try {
        ingestResponse({
          businessId: extra.businessId,
          skill: extra.skill,
          responseBody: r.body,
          logger,
        });
      } catch {
        /* soft */
      }
    }
    if (r.body?.usage) {
      setImmediate(() => {
        const skill = extra.skill || (typeof taskTypeOrModel === 'string' ? taskTypeOrModel : 'unknown');
        observability.costTracker
          .track({
            businessId: extra.businessId || null,
            skill,
            model,
            usage: r.body.usage,
            sbPost,
            logger,
          })
          .catch(() => {});
        const advIn = Number(r.body.usage.advisor_input_tokens) || 0;
        const advOut = Number(r.body.usage.advisor_output_tokens) || 0;
        if ((advIn || advOut) && extra.businessId) {
          observability.costTracker
            .track({
              businessId: extra.businessId,
              skill: `${skill}_advisor`,
              model: extra.advisor?.model || 'claude-opus-4-7',
              usage: { input_tokens: advIn, output_tokens: advOut },
              sbPost,
              logger,
            })
            .catch(() => {});
        }
      });
    }
    if (extra.cacheSystem && r.body?.usage) {
      const u = r.body.usage;
      if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
        logger.info('/claude', extra.businessId || null, 'cache stats', {
          read: u.cache_read_input_tokens || 0,
          created: u.cache_creation_input_tokens || 0,
          uncached: u.input_tokens || 0,
        });
      }
    }
    if (extra.returnFullResponse) return r.body;
    // Citations support — when the caller passed citation-eligible document
    // blocks (extra.documentBlocks with citations:enabled or extra.fileIds
    // + extra.citations:true), they can opt into the parsed citation form:
    //   { renderedText: 'Text with inline [1] markers', citations: [...] }
    // so the dashboard's "Why this?" panel can show source quotes.
    if (extra.returnCitations) {
      try {
        const { parseCitedResponse } = require('./services/anthropic-citations');
        return parseCitedResponse(r.body);
      } catch {
        // Fall through to default text return — Citations module unavailable.
      }
    }
    const raw = r.body?.content?.[0]?.text || '';
    if (extra.returnRaw) return raw;
    return extractJSON(raw) || { _raw: raw };
  }

  /**
   * Streaming Claude call — sends tokens to onToken(chunk) as they arrive.
   * Resolves with the full accumulated text when the stream ends.
   * No retries (streaming retries are complex — caller can retry the whole call).
   */
  async function streamClaude({ model, system, messages, maxTokens = 2500, onToken, businessId, skill }) {
    if (businessId) {
      const { enforceLLMBudget } = require('./lib/llmGateway');
      const budget = await enforceLLMBudget({
        businessId,
        sbGet,
        checkTokenBudgetForBusiness,
      });
      maxTokens = Math.min(maxTokens, budget.maxTokensPerCall || maxTokens);
    }

    // include_usage so Anthropic emits token counts in the SSE frames — without
    // it, streamed AI-Brain turns consumed budget but recorded ZERO cost, so the
    // monthly cap never moved for streaming chat (untracked Anthropic spend).
    const body = { model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, messages };
    if (system) body.system = system;
    const bodyStr = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      let fullText = '';
      // Accumulate token usage across the SSE frames: message_start carries the
      // input/cache usage, message_delta carries cumulative output_tokens.
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const streamReq = https.request(
        {
          hostname: 'api.anthropic.com',
          port: 443,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
        },
        (streamRes) => {
          if (streamRes.statusCode !== 200) {
            let errBody = '';
            streamRes.on('data', (c) => (errBody += c));
            streamRes.on('end', () =>
              reject(new Error(`Claude stream ${model}: ${streamRes.statusCode} ${errBody.slice(0, 300)}`))
            );
            return;
          }
          let buffer = '';
          streamRes.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  fullText += parsed.delta.text;
                  if (onToken) onToken(parsed.delta.text);
                } else if (parsed.type === 'message_start' && parsed.message?.usage) {
                  const u = parsed.message.usage;
                  usage.input_tokens = Number(u.input_tokens) || 0;
                  usage.cache_read_input_tokens = Number(u.cache_read_input_tokens) || 0;
                  usage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens) || 0;
                } else if (parsed.type === 'message_delta' && parsed.usage) {
                  usage.output_tokens = Number(parsed.usage.output_tokens) || usage.output_tokens;
                }
              } catch {
                /* ignore malformed SSE lines */
              }
            }
          });
          streamRes.on('end', () => {
            if (businessId) {
              setImmediate(() => {
                sbGet('businesses', `id=eq.${businessId}&select=user_id`)
                  .then((rows) => recordOrchestrationTaskRun(rows[0]?.user_id || businessId, 'ai_call'))
                  .catch(() => {});
                // Record the streamed call's cost so it counts against the
                // monthly cap (was previously untracked spend).
                if (usage.input_tokens || usage.output_tokens) {
                  observability.costTracker
                    .track({ businessId, skill: skill || 'ai_brain_stream', model, usage, sbPost, logger })
                    .catch(() => {});
                }
              });
            }
            resolve(fullText);
          });
          streamRes.on('error', (e) => reject(e));
        }
      );
      streamReq.on('error', (e) => reject(e));
      streamReq.setTimeout(120000, () => {
        streamReq.destroy(new Error('Stream timeout (120s)'));
      });
      streamReq.write(bodyStr);
      streamReq.end();
    });
  }

  async function fetchPerformanceThemesContextBlock(businessId) {
    if (!businessId) return '';
    try {
      const top = await sbGet(
        'generated_content',
        `business_id=eq.${businessId}&performance_score=not.is.null&order=performance_score.desc&limit=5&select=content_theme,performance_score`
      ).catch(() => []);
      const worst = await sbGet(
        'generated_content',
        `business_id=eq.${businessId}&performance_score=not.is.null&order=performance_score.asc&limit=5&select=content_theme,performance_score`
      ).catch(() => []);
      const bestThemes = (top || []).map((c) => c.content_theme).filter(Boolean);
      const worstThemes = (worst || []).map((c) => c.content_theme).filter(Boolean);
      let s = '';
      if (bestThemes.length)
        s += `BEST PERFORMING THEMES (from recent scored content): ${[...new Set(bestThemes)].join(', ')} — lean into these.\n`;
      if (worstThemes.length)
        s += `WORST PERFORMING THEMES: ${[...new Set(worstThemes)].join(', ')} — avoid repeating these angles.\n`;
      return s.trim() ? s : '';
    } catch {
      return '';
    }
  }

  async function checkOrchestrationIdempotency(userId, taskName, windowMs = 3600000) {
    // Defensive UUID validation — never let an unvalidated userId touch the
    // PostgREST filter even though this is internally called. encodeURIComponent
    // closes the injection vector regardless.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!userId || !UUID_RE.test(String(userId))) {
      // Fail closed on bad input — better to skip a legitimate task than
      // run a duplicate.
      return true;
    }
    try {
      const since = new Date(Date.now() - windowMs).toISOString();
      const rows = await sbGet(
        'orchestration_logs',
        `user_id=eq.${encodeURIComponent(userId)}&task=eq.${encodeURIComponent(taskName)}&created_at=gte.${encodeURIComponent(since)}&limit=1&select=id`
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (e) {
      // Critical change vs prior behavior: on Supabase outage, fail CLOSED
      // (return true = "task ran already, skip") instead of false. The audit
      // flagged this — false meant duplicate charges/emails fired during
      // transient Supabase outages.
      logger.warn('checkOrchestrationIdempotency', userId, 'fail-closed on lookup error', {
        error: e?.message,
        task: taskName,
      });
      return true;
    }
  }

  async function recordOrchestrationTaskRun(userId, taskName, report = '') {
    try {
      await sbPost('orchestration_logs', {
        user_id: userId,
        task: taskName,
        report: report || taskName,
        tasks_planned: [],
        tasks_executed: [],
      });
    } catch (e) {
      // Audit/billing row insert failed — log so we don't silently lose
      // orchestration history. If this fires repeatedly, the cost dashboard
      // will be missing rows and per-business spend will be undercounted.
      logger.warn('recordOrchestrationTaskRun', userId, 'orchestration_logs insert failed', {
        error: e?.message,
        task: taskName,
      });
    }
  }

  async function alertOnRepeatedFailure(userId, endpoint) {
    if (!RESEND_API_KEY || !userId) return;
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const rows = await sbGet(
        'errors',
        `business_id=eq.${userId}&workflow_name=eq.${encodeURIComponent(endpoint)}&created_at=gte.${since}&select=id&limit=5`
      );
      if (!rows || rows.length < 3) return;
      const fromHdr = FROM_EMAIL.includes('<') ? FROM_EMAIL : `maroa.ai <${FROM_EMAIL}>`;
      await apiRequest(
        'POST',
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        {
          from: fromHdr,
          to: ['idealbekteshi06@gmail.com'],
          subject: `Alert: ${endpoint} failing for ${userId}`,
          html: `<p>Endpoint <strong>${endpoint}</strong> has recorded 3+ errors in 24h for client <code>${userId}</code>. Check Railway logs.</p>`,
        }
      ).catch((e) => logger.warn('alertOnRepeatedFailure', userId, 'alert email send failed', { error: e?.message }));
    } catch (e) {
      logger.warn('alertOnRepeatedFailure', userId, 'errors-table lookup failed', { error: e?.message });
    }
  }

  // ─── Universal JSON extractor — handles markdown fences, mixed text, arrays ─
  function extractJSON(text) {
    if (!text) return null;
    // 1. Direct parse
    try {
      return JSON.parse(text);
    } catch {
      /* soft-fail */
    }
    // 2. Strip ALL markdown code fences (global, not just start/end)
    const cleaned = text
      .replace(/```(?:json|javascript|js)?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      /* soft-fail */
    }
    // 3. Find JSON array (greedy — outermost brackets)
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch {
        /* soft-fail */
      }
    }
    // 4. Find JSON object (greedy — outermost braces)
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        /* soft-fail */
      }
    }
    // 5. Repair truncated JSON array — find last complete object and close the array
    const arrStart = cleaned.indexOf('[');
    if (arrStart !== -1) {
      let truncated = cleaned.slice(arrStart);
      // Find the last complete "}" and close the array there
      const lastBrace = truncated.lastIndexOf('}');
      if (lastBrace > 0) {
        const repaired = truncated.slice(0, lastBrace + 1) + ']';
        try {
          return JSON.parse(repaired);
        } catch {
          /* soft-fail */
        }
      }
    }
    return null;
  }

  // ─── OpenAI embedding helper ─────────────────────────────────────────────────
  async function getEmbedding(text) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    // Wrapped: retry+jitter on 429/5xx via externalHttp (L10 hardening).
    const r = await externalHttp(
      apiRequest,
      'POST',
      'https://api.openai.com/v1/embeddings',
      { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      { model: 'text-embedding-3-small', input: text.slice(0, 8000) }
    );
    if (r.status !== 200) throw new Error(`OpenAI embed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body?.data?.[0]?.embedding || [];
  }

  // ─── Pinecone helpers ─────────────────────────────────────────────────────────
  async function pineconeUpsert(vectors) {
    if (!PINECONE_API_KEY || !PINECONE_HOST) throw new Error('Pinecone not configured');
    const r = await apiRequest(
      'POST',
      `${PINECONE_HOST}/vectors/upsert`,
      { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
      { vectors }
    );
    if (![200, 201].includes(r.status))
      throw new Error(`Pinecone upsert: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return r.body;
  }

  async function pineconeQuery(vector, filter = {}, topK = 3) {
    if (!PINECONE_API_KEY || !PINECONE_HOST) return { matches: [] };
    const r = await apiRequest(
      'POST',
      `${PINECONE_HOST}/query`,
      { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
      { vector, filter, topK, includeMetadata: true }
    );
    if (r.status !== 200) return { matches: [] };
    return r.body;
  }

  // ─── Brand memory context helper ─────────────────────────────────────────────
  // Returns a prompt prefix string like "Here are examples…\n---\n" or '' if none
  async function getBrandExamples(business_id, content_type, topic) {
    try {
      if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST) return '';
      const vector = await getEmbedding(topic);
      const result = await pineconeQuery(
        vector,
        { businessId: { $eq: business_id }, contentType: { $eq: content_type } },
        3
      );
      const matches = (result.matches || []).filter((m) => m.score > 0.7 && m.metadata?.text);
      if (!matches.length) return '';
      const examples = matches.map((m) => m.metadata.text).join('\n---\n');
      return `Here are examples of this business's best-performing content — match this exact voice and style:\n${examples}\n\nNow write new content:\n`;
    } catch {
      return '';
    }
  }

  // ─── SerpAPI helper ───────────────────────────────────────────────────────────
  async function serpSearch(query, num = 5) {
    try {
      // Wrapped: retry+jitter + serpapi breaker (L10 hardening).
      const r = await externalHttp(
        apiRequest,
        'GET',
        `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&engine=google&num=${num}`,
        {}
      );
      if (r.status !== 200) return [];
      const results = r.body?.organic_results || [];
      return results.slice(0, num).map((res) => ({
        title: res.title || '',
        link: res.link || '',
        snippet: res.snippet || '',
      }));
    } catch {
      return [];
    }
  }

  const createHiggsfieldService = require('./services/higgsfield');
  const higgsfieldAI = createHiggsfieldService({
    apiRequest,
    serpSearch,
    logger,
    extractJSON,
    sbGet,
    sbPost,
    sbPatch,
    ANTHROPIC_KEY,
    SERPAPI_KEY,
    SUPABASE_URL,
    SUPABASE_KEY,
    // 2026-05-13 audit P2: wire callClaude so claudeVision + claudeText
    // route through it (cost-tracking, retries, prompt-cache, budget gates).
    callClaude,
  });

  // ─── Workflow #1 — Daily Content Engine ──────────────────────────────────────
  // Factory wires: context bundle, strategic decision, platform generation,
  // quality gate, guardrails, publisher, learning loop, daily orchestrator.
  // Strategic framework is imported from services/prompts/foundation.js (auto-
  // generated from the frontend's canonical src/lib/prompts/foundation.ts via
  // scripts/sync_foundation.mjs — do not hand-edit the generated files).
  const createWf1 = require('./services/wf1');
  let countryIntelligenceMod = null;
  try {
    countryIntelligenceMod = require('./services/countryIntelligence');
  } catch {
    /* optional */
  }

  // Pre-create the Anthropic Batch service early so WF1's overnight batch
  // consolidator can wire to it. The other Anthropic services (Files / Memory /
  // Managed Agents) are created later alongside their routes.
  const { createBatchService: _earlyBatchFactory } = require('./services/anthropic-batch');
  const _batchServiceForWf1 = ANTHROPIC_KEY
    ? _earlyBatchFactory({ apiKey: ANTHROPIC_KEY, logger, sbGet, sbPost, sbPatch })
    : null;

  const wf1 = createWf1({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    apiRequest,
    serpSearch,
    countryIntelligence: countryIntelligenceMod,
    checkOrchestrationIdempotency,
    recordOrchestrationTaskRun,
    batchService: _batchServiceForWf1,
    // Enables WF1 to render visuals (media_url) so IG-feed/FB/LinkedIn
    // auto-publish has media instead of failing on a missing asset.
    higgsfield: higgsfieldAI,
    logger,
  });
  const { registerWf1Routes } = require('./services/wf1/registerRoutes');

  // ─── Workflow #13 — Weekly Strategy Brief ────────────────────────────────────
  const createWf13 = require('./services/wf13');
  const wf13 = createWf13({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    countryIntelligence: countryIntelligenceMod,
    logger,
    sendEmail,
    sendWhatsApp,
  });
  const { registerWf13Routes } = require('./services/wf13/registerRoutes');

  // ─── Workflow #15 — AI Brain (Conversational Command Center) ────────────────
  const createWf15 = require('./services/wf15');
  const wf15 = createWf15({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    streamClaude,
    extractJSON,
    logger,
  });
  const { registerWf15Routes } = require('./services/wf15/registerRoutes');

  // ─── Workflow #2 — Lead Scoring & Routing ──────────────────────────────────
  const createWf2 = require('./services/wf2');
  const wf2 = createWf2({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    logger,
    sendEmail,
  });
  const { registerWf2Routes } = require('./services/wf2/registerRoutes');

  // ─── Ad Optimizer (user-facing WF02 — Daily Ad Optimizer) ──────────────────
  // International (multi-region/currency/language), SMB-budget calibrated,
  // trend-aware, anti-thrashing, learning-phase respecting. See CLAUDE.md WF02.
  // Anthropic Memory tool — fire-and-forget per-business memory writes on
  // approve/reject. Module is null when ANTHROPIC_MEMORY_ENABLED isn't set.
  // Constructed here (before agent factories) so adOptimizer + creativeEngine
  // can receive it through DI.
  const _businessMemory = (() => {
    try {
      return require('./lib/businessMemory').makeBusinessMemory({
        apiKey: ANTHROPIC_KEY,
        logger,
      });
    } catch (e) {
      logger?.warn?.('business-memory', null, 'init failed', { error: e.message });
      return null;
    }
  })();

  // Marketing Graph (migration 065) — the moat. Every meaningful decision /
  // creative / approval gets written as a typed entity + edges. Reads + writes
  // compound over time so future agents have ground truth: "this claim worked
  // for this audience on this channel" instead of guessing from prompts.
  // Constructed here (before agent factories) so ad-optimizer + creative-engine
  // receive it via DI and start writing to the graph on day one.
  //
  // Fail-safe: library degrades gracefully when migration 065 isn't applied
  // (isHealthy() returns false, every method returns null/[]).
  const _marketingGraph = (() => {
    try {
      return require('./lib/marketingGraph').makeMarketingGraph({
        sbGet,
        sbPost,
        sbPatch,
        logger,
        metrics: observability?.metrics,
      });
    } catch (e) {
      logger?.warn?.('marketing-graph', null, 'init failed', { error: e.message });
      return null;
    }
  })();

  const createAdOptimizer = require('./services/ad-optimizer');
  const adOptimizer = createAdOptimizer({
    sbGet,
    sbPost,
    sbPatch,
    // sbRpc enables the atomic migration-071 ad_optimizer_decision write
    // (insert audit row + patch campaign in one transaction). Falls back
    // to legacy two-call inside the engine on RPC_NOT_FOUND.
    sbRpc,
    callClaude,
    extractJSON,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
    decisionLog: _decisionLog,
    // Marketing Graph mirror — every executed ad decision becomes a typed
    // entity + edge so the grounding library can later read "what worked
    // for this audience+claim+channel combo." No-op when migration 065
    // hasn't been applied yet (graph.isHealthy() returns false).
    marketingGraph: _marketingGraph,
  });

  // ─── AI-SEO (NEW capability — get sites cited by ChatGPT/Perplexity/Claude) ─
  // 8-dimension audit + llms.txt + JSON-LD schema generation. International,
  // SMB-calibrated, deterministic baseline + LLM synthesis layered on top.
  const createAiSeo = require('./services/ai-seo');
  const aiSeo = createAiSeo({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── CRO (NEW capability — landing-page audit + copy rewrite) ──────────────
  // 7-dimension SMB-calibrated audit + hero/CTA/value-prop rewrites.
  // International (CTA conventions per language), RTL-aware.
  const createCro = require('./services/cro');
  const croService = createCro({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── Pacing Alerts (4-hour cadence between WF02 daily audits) ──────────────
  const createPacingAlerts = require('./services/pacing-alerts');
  const pacingAlerts = createPacingAlerts({
    sbGet,
    sbPost,
    sbPatch,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── Weekly Scorecard (replaces WF17 — Sunday 22:00 UTC) ───────────────────
  const createWeeklyScorecard = require('./services/weekly-scorecard');
  const weeklyScorecard = createWeeklyScorecard({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    sendEmail,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── Forecasting (predictive — ROAS / spend / revenue / LTV / budget alloc) ─
  const createForecasting = require('./services/forecasting');
  const forecasting = createForecasting({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── VOC (Voice-of-Customer — mines reviews/comments/emails for real signal) ─
  const createVoc = require('./services/voc');
  const vocService = createVoc({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    serpSearch,
    apiRequest,
    logger,
    Sentry: typeof Sentry !== 'undefined' ? Sentry : null,
  });

  // ─── Workflow #4 — Reviews & Reputation ────────────────────────────────────
  const createWf4 = require('./services/wf4');
  const wf4 = createWf4({
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    extractJSON,
    logger,
    sendEmail,
    sendWhatsApp,
  });
  const { registerWf4Routes } = require('./services/wf4/registerRoutes');

  // ─── Workflow #3 — Ad Optimization Loop ────────────────────────────────────
  const createWf3 = require('./services/wf3');
  const wf3 = createWf3({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, apiRequest });
  const { registerWf3Routes } = require('./services/wf3/registerRoutes');

  // ─── Workflows #5, #6, #7, #8, #9/11, #10, #12, #14 — batch wiring ──────────
  const createWf5 = require('./services/wf5');
  const createWf6 = require('./services/wf6');
  const createWf7 = require('./services/wf7');
  const createWf8 = require('./services/wf8');
  const createWf9 = require('./services/wf9');
  const createWf11 = require('./services/wf11');
  const createWf10 = require('./services/wf10');
  const createWf12 = require('./services/wf12');
  const createWf14 = require('./services/wf14');

  const wf5 = createWf5({ sbGet, sbPost, callClaude, extractJSON, serpSearch, logger });
  const wf6 = createWf6({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger });
  const wf7 = createWf7({ sbGet, sbPost, sbPatch, callClaude, extractJSON, sendEmail, logger });
  const wf8 = createWf8({ sbGet, sbPost, callClaude, extractJSON, logger });
  const wf9 = createWf9({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger });
  const wf11 = createWf11({ sbGet, sbPost, sbPatch, logger, sendEmail });
  const wf10 = createWf10({ sbGet, sbPost, sbPatch, callClaude, extractJSON, higgsfieldAI, logger });
  const wf12 = createWf12({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger });
  const wf14 = createWf14({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger });

  const { registerBatchRoutes } = require('./services/wf_batch_routes');
  const { registerWf11Routes } = require('./services/wf11/registerRoutes');

  // ─── Save image to Supabase Storage (permanent URL) ──────────────────────────
  async function saveImageToSupabase(imageUrl, businessId) {
    if (!imageUrl || !imageUrl.startsWith('http')) return imageUrl;
    try {
      // Download image as binary buffer
      const imgBuf = await new Promise((resolve, reject) => {
        const u = new URL(imageUrl);
        const proto = u.protocol === 'https:' ? https : http;
        proto
          .get(imageUrl, { headers: { Accept: '*/*' } }, (res) => {
            // Follow redirects
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
              return saveImageToSupabase(res.headers.location, businessId).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          })
          .on('error', reject);
      });

      // Detect content type from URL or default to jpeg
      const ext = imageUrl.includes('.webp') ? 'webp' : imageUrl.includes('.png') ? 'png' : 'jpg';
      const contentType = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
      const fileName = `${businessId}/${Date.now()}.${ext}`;

      // Upload to Supabase Storage via REST API
      const uploadUrl = `${SUPABASE_URL}/storage/v1/object/business-photos/${fileName}`;
      const uploadResp = await new Promise((resolve, reject) => {
        const u = new URL(uploadUrl);
        const req = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': contentType,
              'Content-Length': imgBuf.length,
              'x-upsert': 'false',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          }
        );
        req.on('error', reject);
        req.write(imgBuf);
        req.end();
      });

      if (uploadResp.status >= 200 && uploadResp.status < 300) {
        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/business-photos/${fileName}`;
        log('saveImageToSupabase', `✅ saved ${fileName} (${imgBuf.length} bytes)`);
        return publicUrl;
      }
      log('saveImageToSupabase', `⚠️ upload failed (${uploadResp.status}): ${uploadResp.body?.slice(0, 200)}`);
      return imageUrl; // fallback to original URL
    } catch (err) {
      log('saveImageToSupabase', `⚠️ error: ${err.message}`);
      return imageUrl; // fallback to original URL
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SMART IMAGE GENERATION SYSTEM — Multi-model with plan-based routing
  // ═════════════════════════════════════════════════════════════════════════════

  // ── Model: Ideogram V2 Turbo ─────────────────────────────────────────────────
  const IDEOGRAM_API_KEY = clean(process.env.IDEOGRAM_API_KEY) || '';
  async function generateWithIdeogram(prompt, aspectRatio = '1:1') {
    if (!IDEOGRAM_API_KEY) throw new Error('IDEOGRAM_API_KEY not set');
    const aspectMap = { '1:1': 'ASPECT_1_1', '9:16': 'ASPECT_9_16', '16:9': 'ASPECT_16_9' };
    const r = await apiRequest(
      'POST',
      'https://api.ideogram.ai/generate',
      { 'Api-Key': IDEOGRAM_API_KEY, 'Content-Type': 'application/json' },
      {
        image_request: {
          prompt: (prompt + '. No text, no words, no watermarks.').slice(0, 1200),
          negative_prompt: IMAGE_NEGATIVE_PROMPT,
          model: 'V_2_TURBO',
          magic_prompt_option: 'AUTO',
          style_type: 'REALISTIC',
          aspect_ratio: aspectMap[aspectRatio] || 'ASPECT_1_1',
        },
      }
    );
    if (r.status !== 200) throw new Error(`Ideogram: ${r.status}`);
    const url = r.body?.data?.[0]?.url;
    if (!url) throw new Error('No image from Ideogram');
    return url;
  }

  // ── Model: Flux 1.1 Pro via Replicate ────────────────────────────────────────
  async function generateWithFlux(prompt) {
    if (!REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY not set');
    // Wrapped: replicate breaker + retry+jitter (image gen is flaky, 30-60s normal).
    const pred = await externalHttp(
      apiRequest,
      'POST',
      'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
      { Authorization: `Bearer ${REPLICATE_API_KEY}`, 'Content-Type': 'application/json', Prefer: 'wait' },
      {
        input: {
          prompt: prompt.slice(0, 500),
          negative_prompt: IMAGE_NEGATIVE_PROMPT,
          aspect_ratio: '1:1',
          output_format: 'webp',
          safety_tolerance: 2,
        },
      }
    );
    if (pred.status === 200 || pred.status === 201) {
      let output = pred.body?.output;
      if (!output && pred.body?.id) {
        const predId = pred.body.id;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await externalHttp(apiRequest, 'GET', `https://api.replicate.com/v1/predictions/${predId}`, {
            Authorization: `Bearer ${REPLICATE_API_KEY}`,
          });
          if (poll.body?.status === 'succeeded') {
            output = poll.body.output;
            break;
          }
          if (poll.body?.status === 'failed') break;
        }
      }
      if (output) {
        const url = Array.isArray(output) ? output[0] : output;
        if (url && url.startsWith('http')) return url;
      }
    }
    throw new Error('Flux generation failed');
  }

  // ── Model: DALL-E 3 via OpenAI ───────────────────────────────────────────────
  async function generateWithDalle3(prompt) {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    // Wrapped: retry+jitter on 429/5xx.
    const r = await externalHttp(
      apiRequest,
      'POST',
      'https://api.openai.com/v1/images/generations',
      { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      {
        model: 'dall-e-3',
        prompt: (prompt + '. Professional marketing image, clean composition, no text.').slice(0, 4000),
        n: 1,
        size: '1024x1024',
        quality: 'hd',
        style: 'natural',
      }
    );
    if (r.status !== 200) throw new Error(`DALL-E 3: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const url = r.body?.data?.[0]?.url;
    if (!url) throw new Error('No URL in DALL-E 3 response');
    return url;
  }

  // ── Model: Gemini image generation ───────────────────────────────────────────
  async function generateWithGemini(prompt, businessId) {
    if (!GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY not set');
    const fullPrompt =
      prompt + '. Professional marketing image, photorealistic, high quality, no text overlays, clean composition.';
    const body = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    };
    // Try gemini-2.0-flash-exp (image generation capable model)
    const r = await apiRequest(
      'POST',
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`,
      { 'Content-Type': 'application/json' },
      body
    );
    if (r.status !== 200) throw new Error(`Gemini: ${r.status}`);
    const parts = r.body?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inlineData);
    if (!imgPart?.inlineData?.data) throw new Error('No image in Gemini response');
    // Upload base64 buffer to Supabase directly
    const buf = Buffer.from(imgPart.inlineData.data, 'base64');
    const mime = imgPart.inlineData.mimeType || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const fileName = `${businessId}/${Date.now()}_gemini.${ext}`;
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/business-photos/${fileName}`;
    const uploadResp = await new Promise((resolve, reject) => {
      const u = new URL(uploadUrl);
      const req = https.request(
        {
          hostname: u.hostname,
          port: 443,
          path: u.pathname,
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': mime,
            'Content-Length': buf.length,
            'x-upsert': 'false',
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }
      );
      req.on('error', reject);
      req.write(buf);
      req.end();
    });
    if (uploadResp.status >= 200 && uploadResp.status < 300) {
      return `${SUPABASE_URL}/storage/v1/object/public/business-photos/${fileName}`;
    }
    throw new Error(`Gemini upload failed: ${uploadResp.status}`);
  }

  // ── Model: Pexels stock photo ────────────────────────────────────────────────
  async function generateWithPexels(query) {
    if (!PEXELS_API_KEY) throw new Error('PEXELS_API_KEY not set');
    const r = await apiRequest(
      'GET',
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=square`,
      { Authorization: PEXELS_API_KEY }
    );
    if (r.status === 200 && r.body?.photos?.[0]) {
      const photo = r.body.photos[Math.floor(Math.random() * Math.min(3, r.body.photos.length))];
      return { url: photo.src?.medium || photo.src?.original, credit: photo.photographer };
    }
    throw new Error('No Pexels results');
  }

  // ── Model order by plan + content type ───────────────────────────────────────
  function getModelOrder(plan, contentType) {
    // All plans get AI-generated images — Pexels is last resort only
    if (plan === 'agency') {
      if (['ad_creative', 'hero_image', 'product_photo'].includes(contentType))
        return ['ideogram', 'gemini', 'flux', 'dalle3', 'pexels'];
      return ['ideogram', 'gemini', 'flux', 'pexels'];
    }
    if (plan === 'growth') {
      return ['ideogram', 'flux', 'gemini', 'pexels'];
    }
    // starter — still gets AI images, just fewer model options
    return ['flux', 'gemini', 'pexels'];
  }

  // ── Business-type image style rules ─────────────────────────────────────────
  const IMAGE_STYLE_RULES = {
    fitness: {
      lighting: 'dramatic side lighting with rim light',
      mood: 'intense and aspirational',
      aesthetic: 'Nike campaign sports photography',
      colors: 'high contrast warm tones with deep shadows',
      extra: 'motion blur or frozen action, strong shadows, athletic energy',
    },
    restaurant: {
      lighting: 'warm studio lighting with soft golden glow',
      mood: 'appetizing and luxurious',
      aesthetic: 'Michelin restaurant food photography',
      colors: 'rich warm golden tones',
      extra: 'shallow depth of field, steam rising, close-up textures',
    },
    cafe: {
      lighting: 'soft warm morning light',
      mood: 'cozy and inviting',
      aesthetic: 'lifestyle coffee photography',
      colors: 'warm browns, cream, natural tones',
      extra: 'latte art, steam, rustic textures',
    },
    beauty: {
      lighting: 'soft diffused lighting, clean whites',
      mood: 'elegant and luxurious',
      aesthetic: 'luxury beauty brand campaign',
      colors: 'soft pastels, blush pink, clean white',
      extra: 'macro detail shots, dewy textures',
    },
    retail: {
      lighting: 'bright clean studio lighting',
      mood: 'fresh and inviting',
      aesthetic: 'lifestyle product photography',
      colors: 'bright and airy, natural tones',
      extra: 'clean background, styled flat lay',
    },
    medical: {
      lighting: 'clean even lighting, clinical whites',
      mood: 'trustworthy and calm',
      aesthetic: 'healthcare brand photography',
      colors: 'calm blues, clean whites, soft greens',
      extra: 'trust-building composition',
    },
    realestate: {
      lighting: 'golden hour natural lighting',
      mood: 'aspirational and inviting',
      aesthetic: 'architectural photography',
      colors: 'warm golden hour tones, blue sky',
      extra: 'wide angle, HDR look',
    },
    education: {
      lighting: 'bright warm natural lighting',
      mood: 'optimistic and engaging',
      aesthetic: 'education brand photography',
      colors: 'warm friendly tones, bright accents',
      extra: 'candid feel, genuine expression',
    },
    events: {
      lighting: 'dramatic colored lighting, stage lights',
      mood: 'energetic and exciting',
      aesthetic: 'event photography',
      colors: 'vibrant saturated colors, light trails',
      extra: 'motion, energy, bokeh lights',
    },
    tech: {
      lighting: 'clean modern lighting, cool tones',
      mood: 'innovative and sleek',
      aesthetic: 'tech brand photography',
      colors: 'cool blues, dark backgrounds, neon accents',
      extra: 'minimalist, futuristic feel',
    },
    automotive: {
      lighting: 'dramatic automotive lighting, reflections',
      mood: 'powerful and sleek',
      aesthetic: 'car advertisement photography',
      colors: 'deep blacks, metallic highlights',
      extra: 'motion blur, reflection shots',
    },
    default: {
      lighting: 'professional studio lighting',
      mood: 'modern and polished',
      aesthetic: 'commercial brand photography',
      colors: 'clean natural tones',
      extra: 'clean composition, professional quality',
    },
  };

  const IMAGE_NEGATIVE_PROMPT =
    'blurry, low quality, stock photo, watermark, text, logo, oversaturated, dark, muddy, amateur, pixelated, distorted, cartoon, illustration, painting, generic';

  function detectImageStyle(businessType) {
    const t = (businessType || '').toLowerCase();
    if (t.includes('fitness') || t.includes('gym') || t.includes('sport')) return IMAGE_STYLE_RULES.fitness;
    if (t.includes('restaurant') || t.includes('food') || t.includes('bar')) return IMAGE_STYLE_RULES.restaurant;
    if (t.includes('cafe') || t.includes('coffee')) return IMAGE_STYLE_RULES.cafe;
    if (t.includes('beauty') || t.includes('salon') || t.includes('spa')) return IMAGE_STYLE_RULES.beauty;
    if (t.includes('retail') || t.includes('shop') || t.includes('store')) return IMAGE_STYLE_RULES.retail;
    if (t.includes('medical') || t.includes('health') || t.includes('dental')) return IMAGE_STYLE_RULES.medical;
    if (t.includes('real estate') || t.includes('property')) return IMAGE_STYLE_RULES.realestate;
    if (t.includes('education') || t.includes('tutor')) return IMAGE_STYLE_RULES.education;
    if (t.includes('event') || t.includes('entertainment')) return IMAGE_STYLE_RULES.events;
    if (t.includes('tech') || t.includes('software')) return IMAGE_STYLE_RULES.tech;
    if (t.includes('auto') || t.includes('car')) return IMAGE_STYLE_RULES.automotive;
    return IMAGE_STYLE_RULES.default;
  }

  // ── Smart prompt builder (business-type aware) ──────────────────────────────
  async function buildImagePrompt(basePrompt, contentType, plan, profile) {
    const style = detectImageStyle(profile?.business_type);
    const aspect = ['video_thumbnail', 'reel_cover', 'instagram_story'].includes(contentType)
      ? '9:16'
      : ['blog_featured', 'facebook_post', 'ad_creative'].includes(contentType)
        ? '16:9'
        : '1:1';
    const audienceCtx = profile?.audience_description ? `, relatable to ${profile.audience_description}` : '';
    const cityCtx = profile?.physical_locations?.[0]?.city
      ? `, local feel of ${profile.physical_locations[0].city}`
      : '';

    const structured = `${basePrompt}, ${style.lighting}, composition with clear space for text overlay, ${style.mood} mood, ${style.aesthetic}, ${style.colors}, ${aspect} format, professional marketing photography, commercial quality, ${style.extra}${audienceCtx}${cityCtx}, no text on image, no watermarks`;

    if (plan === 'agency') {
      try {
        const result = await callClaude(
          `You are an expert AI image prompt engineer for a ${profile?.business_type || 'business'}.\nENHANCE this prompt to be vivid and specific. Keep ALL technical details.\nOriginal: "${structured}"\nReturn ONLY the enhanced prompt, max 200 words.`,
          'short_copy',
          300,
          { returnRaw: true }
        );
        const enhanced = typeof result === 'string' ? result : result?._raw || structured;
        log('buildImagePrompt', `[AGENCY] ${enhanced.slice(0, 120)}...`);
        return enhanced;
      } catch {
        /* soft-fail */
      }
    }

    log('buildImagePrompt', `[${(plan || 'default').toUpperCase()}] ${structured.slice(0, 120)}...`);
    return structured;
  }

  // ── MAIN: generateSmartImage ─────────────────────────────────────────────────
  async function generateSmartImage(businessId, prompt, contentType = 'social_post', plan = 'free') {
    const startTime = Date.now();
    // Fetch profile for business-type-aware image prompts
    let profile = null;
    try {
      const r = await sbGet(
        'business_profiles',
        `user_id=eq.${businessId}&select=business_type,physical_locations,audience_description`
      ).catch(() => []);
      profile = r[0];
    } catch {
      /* soft-fail */
    }
    if (!profile) {
      try {
        const r = await sbGet('businesses', `id=eq.${businessId}&select=industry,location,target_audience`);
        if (r[0])
          profile = {
            business_type: r[0].industry,
            physical_locations: r[0].location ? [{ city: r[0].location }] : [],
            audience_description: r[0].target_audience,
          };
      } catch {
        /* soft-fail */
      }
    }

    const enhanced = await buildImagePrompt(prompt, contentType, plan, profile);
    const models = getModelOrder(plan, contentType);
    const fallbackQ = prompt.split(',')[0] || 'professional business marketing';
    const aspect = ['video_thumbnail', 'reel_cover', 'instagram_story'].includes(contentType)
      ? '9:16'
      : ['blog_featured', 'facebook_post', 'ad_creative'].includes(contentType)
        ? '16:9'
        : '1:1';

    for (const model of models) {
      try {
        let url = null;
        if (model === 'ideogram') {
          url = await generateWithIdeogram(enhanced, aspect);
        } else if (model === 'gemini') {
          url = await generateWithGemini(enhanced, businessId);
          // Gemini already uploaded to Supabase, URL is permanent
          return { url, source: 'gemini', model_used: 'gemini', generation_time_ms: Date.now() - startTime };
        } else if (model === 'flux') {
          url = await generateWithFlux(enhanced);
        } else if (model === 'dalle3') {
          url = await generateWithDalle3(enhanced);
        } else if (model === 'pexels') {
          const pex = await generateWithPexels(fallbackQ);
          url = pex.url;
          if (url) {
            const permUrl = await saveImageToSupabase(url, businessId);
            return {
              url: permUrl,
              source: 'pexels',
              credit: pex.credit,
              model_used: 'pexels',
              generation_time_ms: Date.now() - startTime,
            };
          }
          continue;
        }
        if (url) {
          const permUrl = await saveImageToSupabase(url, businessId);
          return { url: permUrl, source: model, model_used: model, generation_time_ms: Date.now() - startTime };
        }
      } catch (err) {
        log('generateSmartImage', `${model} failed: ${err.message}`);
        continue;
      }
    }
    // P1-3 (audit 2026-05-20): full fallback chain exhausted. Log loudly so
    // observability can alert on rising "image_source=none" rates. Pre-fix
    // this returned silently and the dashboard showed an empty image with
    // no breadcrumb for ops.
    log(
      'generateSmartImage',
      `ALL MODELS EXHAUSTED for businessId=${businessId} contentType=${contentType} plan=${plan} prompt=${String(prompt).slice(0, 60)}`
    );
    try {
      if (typeof Sentry?.captureMessage === 'function') {
        Sentry.captureMessage('image-gen all models exhausted', {
          level: 'warning',
          tags: { route: 'generateSmartImage', business_id: businessId, plan, content_type: contentType },
          extra: { prompt: String(prompt).slice(0, 200) },
        });
      }
    } catch {
      /* soft-fail */
    }
    return { url: null, source: 'none', model_used: 'none', generation_time_ms: Date.now() - startTime };
  }

  // ── Backwards compat: old generateImage still works ──────────────────────────
  async function generateImage(prompt, fallbackQuery = 'business marketing professional') {
    const result = await generateSmartImage('default', prompt, 'social_post', 'growth');
    return { url: result.url, source: result.source, credit: result.credit };
  }

  // ─── Email helper (Resend HTTPS API — works on Railway, no SMTP needed) ──────
  // Railway blocks outbound SMTP (465/587). Resend uses HTTPS port 443 only.
  // Sign up free at resend.com → get API key → set RESEND_API_KEY on Railway.
  // Set FROM_EMAIL to a verified domain address (or leave as onboarding@resend.dev for testing).
  sendEmail = async function sendEmail(to, subject, html) {
    const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
    const from = clean(process.env.FROM_EMAIL) || FROM_EMAIL;

    if (!apiKey || !to) {
      console.log('[REDACTED]');
      return { queued: true };
    }

    try {
      const r = await apiRequest(
        'POST',
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        { from: `maroa.ai <${from}>`, to: [to], reply_to: 'hello@maroa.ai', subject, html }
      );
      if (r.status === 200 || r.status === 201) {
        console.log('[EMAIL SENT] id:', r.body?.id);
        return { sent: true, id: r.body?.id };
      }
      const msg = r.body?.message || r.body?.name || JSON.stringify(r.body).slice(0, 200);
      console.error(`[EMAIL ERROR] ${r.status}: ${msg}`);
      return { error: msg, status: r.status };
    } catch (e) {
      console.error('[EMAIL ERROR]', e.message);
      return { error: e.message };
    }
  };

  // ─── WhatsApp helper (Twilio) ────────────────────────────────────────────────
  async function sendWhatsApp(to, message) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !to) {
      console.log('[WHATSAPP QUEUED] Twilio not configured');
      return { queued: true };
    }
    try {
      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      const body = `From=${encodeURIComponent(TWILIO_WHATSAPP_FROM)}&To=${encodeURIComponent('whatsapp:' + to)}&Body=${encodeURIComponent(message)}`;
      // Twilio needs form-encoded, use raw https
      const resp = await new Promise((resolve, reject) => {
        const u = new URL(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`);
        const req = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(d));
              } catch {
                resolve({ raw: d });
              }
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      if (resp.sid) {
        console.log('[REDACTED]');
        return { sent: true, sid: resp.sid };
      }
      return { error: resp.message || 'unknown' };
    } catch (e) {
      console.error('[WHATSAPP ERROR]', e.message);
      return { error: e.message };
    }
  }

  // ─── Webhook dispatcher (fires external webhook subscriptions) ──────────────
  async function fireWebhooks(businessId, eventType, data) {
    try {
      if (!isUUID(String(businessId))) return;
      const subs = await sbGet(
        'webhook_subscriptions',
        `business_id=eq.${encodeURIComponent(businessId)}&event_type=eq.${encodeURIComponent(String(eventType))}&active=eq.true`
      );
      for (const sub of subs) {
        // Re-validate the stored URL at fire time — defeats DNS rebinding and
        // any subscription that slipped in before this guard existed.
        try {
          await assertPublicHttpUrl(sub.webhook_url);
        } catch {
          continue;
        }
        apiRequest(
          'POST',
          sub.webhook_url,
          { 'Content-Type': 'application/json', 'X-Maroa-Secret': sub.secret || '' },
          { event: eventType, business_id: businessId, timestamp: new Date().toISOString(), data },
          EXTERNAL_HTTP_TIMEOUT_MS,
          { allowInternalSecret: false }
        ).catch(() => {});
      }
    } catch {
      /* soft-fail */
    }
  }

  // ─── Simple rate limiter ─────────────────────────────────────────────────────
  const rateLimitStore = new Map();
  function rateLimit(key, maxPerWindow, windowMs = 60000) {
    const now = Date.now();
    const bucket = rateLimitStore.get(key) || [];
    const valid = bucket.filter((ts) => ts > now - windowMs);
    if (valid.length >= maxPerWindow) return false; // over limit
    valid.push(now);
    rateLimitStore.set(key, valid);
    return true; // allowed
  }
  // Clean stale entries every 5 minutes. .unref() so this timer never keeps the
  // event loop alive (consistent with the other sweepers — lets the process exit
  // cleanly on non-signal paths).
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore) {
      const valid = v.filter((ts) => ts > now - 300000);
      if (valid.length === 0) rateLimitStore.delete(k);
      else rateLimitStore.set(k, valid);
    }
  }, 300000).unref();

  // ─── Simple response cache (30s TTL) ────────────────────────────────────────
  const responseCache = new Map();
  function getCached(key) {
    const entry = responseCache.get(key);
    if (entry && Date.now() - entry.ts < 30000) return entry.data;
    responseCache.delete(key);
    return null;
  }
  function setCache(key, data) {
    responseCache.set(key, { data, ts: Date.now() });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PREMIUM INTELLIGENCE ENGINE — Multi-pass, Memory, Scheduling, Recovery
  // ═════════════════════════════════════════════════════════════════════════════

  // ── T1.1: Multi-pass content generation (generate → critique → refine) ──────
  async function generateWithRefinement(basePrompt, taskType, profile, bizId) {
    // Pass 1: Generate with Opus
    const draft = await callClaude(basePrompt, taskType || 'social_post', 3000);
    if (draft._raw || !draft) return draft; // unparseable — return as-is

    const mainText =
      draft.instagram_caption || draft.facebook_post || draft.email_body || JSON.stringify(draft).slice(0, 500);
    if (mainText.length < 30) return draft;

    // Pass 2: Critique
    try {
      const critiquePrompt = `You are a senior marketing director reviewing content for ${profile?.business_name || 'a local business'} in ${profile?.physical_locations?.[0]?.city || 'Kosovo'}.\n\nCONTENT:\n"${mainText.slice(0, 600)}"\n\nScore 1-10:\n1. Specificity (is it for THIS business or generic?)\n2. Hook strength (would someone stop scrolling?)\n3. Local relevance (does it feel local?)\n4. CTA clarity\n5. Language match (${profile?.primary_language || 'English'})\n\nIf ANY score < 7, list exact fixes.\nReturn ONLY valid JSON: {"scores":{"specificity":0,"hook":0,"local":0,"cta":0,"language":0},"needs_refinement":false,"improvements":[]}`;
      const critique = await callClaude(critiquePrompt, 'short_copy', 400);
      if (critique?.needs_refinement && Array.isArray(critique.improvements) && critique.improvements.length > 0) {
        // Pass 3: Refine
        const refinePrompt = `Rewrite this content for ${profile?.business_name || 'the business'} fixing these issues:\n${critique.improvements.join('\n')}\n\nOriginal:\n${mainText}\n\nSame language (${profile?.primary_language || 'English'}). Same JSON format as original. Return ONLY valid JSON.`;
        const refined = await callClaude(refinePrompt, taskType || 'social_post', 3000);
        if (refined && !refined._raw) {
          log('multiPass', `Refined: ${critique.improvements.length} issues fixed`);
          return refined;
        }
      }
    } catch (e) {
      log('multiPass', `Critique skipped: ${e.message}`);
    }
    return draft;
  }

  // ── T1.3: Platform rules enforcement ─────────────────────────────────────────
  const PLATFORM_RULES = {
    instagram: { maxLen: 2200, hashtagCount: 5, hookLen: 125 },
    facebook: { maxLen: 500, hashtagCount: 2, hookLen: 80 },
    email: { subjectMax: 60, bodyMax: 800 },
    whatsapp: { maxLen: 160 },
    ad: { headlineMax: 40, bodyMax: 125 },
  };

  function enforcePlatformRules(text, platform, profile) {
    if (!text || typeof text !== 'string') return text;
    const rules = PLATFORM_RULES[platform];
    if (!rules) return text;
    // Truncate if too long
    if (rules.maxLen && text.length > rules.maxLen) text = text.slice(0, rules.maxLen - 3) + '...';
    // Add local hashtags for social platforms if missing
    if (
      (platform === 'instagram' || platform === 'facebook') &&
      !text.includes('#') &&
      profile?.physical_locations?.[0]?.city
    ) {
      const city = profile.physical_locations[0].city.toLowerCase().replace(/\s+/g, '');
      text += `\n\n#${city} #kosova`;
    }
    return text;
  }

  // ── T2.1: Memory system (AI learns from every interaction) ───────────────────
  async function storeMemory(userId, memoryType, action, contentSnippet, platform, pattern) {
    try {
      await sbPost('ai_memory', {
        user_id: userId,
        memory_type: memoryType,
        action,
        content_snippet: (contentSnippet || '').slice(0, 500),
        platform: platform || 'general',
        learned_pattern: (pattern || '').slice(0, 500),
      }).catch(() => {});
    } catch {
      /* soft-fail */
    }
  }

  async function getMemoryContext(userId) {
    try {
      const rows = await sbGet('ai_memory', `user_id=eq.${userId}&order=created_at.desc&limit=30`);
      if (!rows.length) return '';
      const wins = rows.filter(
        (r) => r.memory_type === 'content_wins' || r.action === 'approved' || r.action === 'high_performance'
      );
      const losses = rows.filter(
        (r) => r.memory_type === 'content_losses' || r.action === 'rejected' || r.action === 'low_performance'
      );
      const prefs = rows.filter((r) => r.memory_type === 'preferences' || r.action === 'edited');
      let ctx = '\n═══ AI MEMORY — WHAT I KNOW ABOUT THIS BUSINESS ═══\n';
      if (wins.length)
        ctx += `What worked (${wins.length} wins):\n${wins
          .slice(0, 5)
          .map((w) => `- ${w.learned_pattern || w.content_snippet?.slice(0, 80) || w.action}`)
          .join('\n')}\n`;
      if (losses.length)
        ctx += `What didn't work (${losses.length}):\n${losses
          .slice(0, 3)
          .map((l) => `- ${l.learned_pattern || l.action}`)
          .join('\n')}\n`;
      if (prefs.length)
        ctx += `Client preferences:\n${prefs
          .slice(0, 3)
          .map((p) => `- ${p.action}: ${p.content_snippet?.slice(0, 60) || ''}`)
          .join('\n')}\n`;
      ctx += 'Apply all learnings to make content better than before.\n';
      return ctx;
    } catch {
      return '';
    }
  }

  const promptCache = new Map();
  const PROMPT_CACHE_TTL = 5 * 60 * 1000;

  async function getCachedMasterPrompt(cacheSubjectId, profile, taskType, extraCtx) {
    const { buildMasterPromptWithSkills } = require('./services/masterPromptBuilder');
    const keyExtra = crypto
      .createHash('sha256')
      .update(String(extraCtx || ''))
      .digest('hex')
      .slice(0, 24);
    const cacheKey = `${cacheSubjectId}:${taskType}:${keyExtra}`;
    const cached = promptCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PROMPT_CACHE_TTL) {
      return cached.prompt;
    }
    const prompt =
      (await buildMasterPromptWithSkills(
        profile,
        taskType,
        getEmbedding,
        pineconeQuery,
        buildIntelligenceContext,
        getMemoryContext,
        extraCtx || ''
      )) + '\n\n';
    promptCache.set(cacheKey, { prompt, timestamp: Date.now() });
    if (promptCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of promptCache.entries()) {
        if (now - value.timestamp > PROMPT_CACHE_TTL) promptCache.delete(key);
      }
    }
    return prompt;
  }

  // ── T2.2: Opportunity detector ───────────────────────────────────────────────
  async function detectOpportunities(userId, profile) {
    const ops = [];
    try {
      // Check posting gap
      const recent = await sbGet(
        'generated_content',
        `business_id=eq.${userId}&status=eq.published&order=created_at.desc&limit=1&select=created_at`
      ).catch(() => []);
      if (!recent.length || Date.now() - new Date(recent[0]?.created_at).getTime() > 3 * 86400000) {
        ops.push({
          type: 'posting_gap',
          priority: 'urgent',
          title: 'No post in 3+ days',
          action: 'Generate and publish content today',
        });
      }
      // Check holiday
      try {
        const { getKosovoAlbaniaHolidays } = require('./services/masterPromptBuilder');
        const holidays = getKosovoAlbaniaHolidays(new Date());
        if (holidays.length)
          ops.push({ type: 'holiday', priority: 'high', title: holidays[0], action: 'Create holiday-themed content' });
      } catch {
        /* soft-fail */
      }
      // Check competitor activity
      const intel = await sbGet(
        'business_intelligence',
        `user_id=eq.${userId}&source_module=eq.competitors&order=updated_at.desc&limit=1`
      ).catch(() => []);
      if (intel.length && Date.now() - new Date(intel[0].updated_at).getTime() < 86400000) {
        ops.push({
          type: 'competitor',
          priority: 'high',
          title: 'Competitor activity detected',
          action: intel[0].insight_value?.slice(0, 100) || 'Create counter-content',
        });
      }
    } catch {
      /* soft-fail */
    }
    return ops.sort(
      (a, b) =>
        (({ urgent: 0, high: 1, medium: 2 })[a.priority] || 3) - ({ urgent: 0, high: 1, medium: 2 }[b.priority] || 3)
    );
  }

  // ── T3.2: Smart scheduling (optimal posting times for Kosovo/Albania) ────────
  function getOptimalPostingTime(platform, businessType) {
    const type = (businessType || '').toLowerCase();
    const now = new Date();
    const hours = {
      instagram: type.includes('fitness')
        ? [7, 12, 17, 20]
        : type.includes('restaurant')
          ? [11, 12, 17, 19]
          : [8, 12, 19, 20],
      facebook: type.includes('restaurant') ? [11, 17, 18] : [9, 13, 19],
      email: [9, 10, 11],
    };
    const bestHours = hours[platform] || hours.instagram;
    // Find next available hour
    for (let dayOff = 0; dayOff <= 2; dayOff++) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOff);
      if (d.getDay() === 0) continue; // Skip Sunday
      for (const h of bestHours) {
        if (dayOff === 0 && h <= now.getHours()) continue;
        d.setHours(h, 0, 0, 0);
        return d.toISOString();
      }
    }
    const tmrw = new Date(now);
    tmrw.setDate(tmrw.getDate() + 1);
    tmrw.setHours(9, 0, 0, 0);
    return tmrw.toISOString();
  }

  // ── T3.3: Auto-recovery with template fallback ──────────────────────────────
  function generateTemplateFallback(profile, taskType) {
    const city = profile?.physical_locations?.[0]?.city || 'Kosovë';
    const name = profile?.business_name || 'Biznesi ynë';
    const offer = profile?.current_offer || '';
    const templates = {
      social_post: `✨ ${name} — ${profile?.usp || 'Shërbimi më i mirë në ' + city}\n\n${offer ? '🎯 ' + offer + '\n\n' : ''}📍 ${city}\n📞 Na kontaktoni tani\n\n#${city.toLowerCase().replace(/\s/g, '')} #kosova`,
      email: `Përshëndetje nga ${name}!\n\n${offer || 'Na vizitoni për shërbimin më të mirë në ' + city}.\n\nMe respekt,\n${name}`,
      ad_copy: `${profile?.usp || name} — #1 në ${city}. ${offer || 'Kontaktoni sot!'}`,
    };
    return templates[taskType] || templates.social_post;
  }

  // ─── SSE client store ────────────────────────────────────────────────────────
  const sseClients = new Map();
  function sendSSE(businessId, eventType, data) {
    const client = sseClients.get(businessId);
    if (client && !client.writableEnded) {
      try {
        client.write(`data: ${JSON.stringify({ type: eventType, timestamp: new Date().toISOString(), ...data })}\n\n`);
      } catch {
        /* soft-fail */
      }
    }
  }

  // ─── Utility: season + holidays ──────────────────────────────────────────────
  function getSeason() {
    const m = new Date().getMonth() + 1;
    if (m >= 3 && m <= 5) return 'Spring';
    if (m >= 6 && m <= 8) return 'Summer';
    if (m >= 9 && m <= 11) return 'Fall';
    return 'Winter';
  }

  function getUpcomingHolidays() {
    const holidays = [
      { m: 1, d: 1, name: "New Year's Day" },
      { m: 1, d: 15, name: 'MLK Day' },
      { m: 2, d: 14, name: "Valentine's Day" },
      { m: 3, d: 17, name: "St. Patrick's Day" },
      { m: 5, d: 5, name: 'Cinco de Mayo' },
      { m: 5, d: 12, name: "Mother's Day" },
      { m: 5, d: 27, name: 'Memorial Day' },
      { m: 6, d: 19, name: 'Juneteenth' },
      { m: 7, d: 4, name: 'Independence Day' },
      { m: 9, d: 2, name: 'Labor Day' },
      { m: 10, d: 31, name: 'Halloween' },
      { m: 11, d: 11, name: 'Veterans Day' },
      { m: 11, d: 28, name: 'Thanksgiving' },
      { m: 12, d: 24, name: 'Christmas Eve' },
      { m: 12, d: 25, name: 'Christmas' },
      { m: 12, d: 31, name: "New Year's Eve" },
    ];
    const now = new Date();
    const soon = [];
    for (const h of holidays) {
      let d = new Date(now.getFullYear(), h.m - 1, h.d);
      if (d < now) d = new Date(now.getFullYear() + 1, h.m - 1, h.d);
      const diff = Math.ceil((d - now) / 86400000);
      if (diff <= 21) soon.push(`${h.name} (in ${diff} days)`);
    }
    return soon.length ? soon.join(', ') : 'No major holidays in next 21 days';
  }

  // ─── Content quality scorer ───────────────────────────────────────────────────
  function scoreContent(c) {
    let score = 0;
    const ig = c.instagram_caption || '';
    const ig2 = c.instagram_caption_2 || '';
    const fb = c.facebook_post || '';
    const sub = c.email_subject || '';
    const hl = c.google_ad_headline || '';
    const desc = c.google_ad_description || '';

    if ((ig.match(/[\u{1F000}-\u{1FFFF}]/gu) || []).length >= 3) score += 10; // 3+ emojis
    if ((ig.match(/#\w+/g) || []).length >= 5) score += 15; // 5+ hashtags
    if (ig.includes('?')) score += 5; // question
    if (ig2.length > 80) score += 10;
    if (fb.split(' ').length >= 100) score += 15; // 100+ words Facebook
    if (sub.length > 5 && sub.length <= 50) score += 10; // good email subject
    if (hl.length > 0 && hl.length <= 30) score += 10; // headline char limit
    if (desc.length > 0 && desc.length <= 90) score += 10; // desc char limit
    if (c.content_theme) score += 5;
    if (c.image_prompt) score += 5;
    if (c.linkedin_post && c.linkedin_post.length > 100) score += 5;

    return Math.min(score, 100);
  }

  // ─── Self-learning system ─────────────────────────────────────────────────────
  async function updateLearning(businessId) {
    try {
      const perf = await sbGet(
        'content_performance',
        `business_id=eq.${businessId}&select=content_id,content_theme,reach,likes,shares,comments`
      );
      if (!perf.length) return;

      // Group by theme and score
      const themes = {};
      for (const p of perf) {
        const t = p.content_theme || 'unknown';
        if (!themes[t]) themes[t] = { reach: 0, engage: 0, count: 0 };
        themes[t].reach += p.reach || 0;
        themes[t].engage += (p.likes || 0) + (p.shares || 0) * 3 + (p.comments || 0) * 2;
        themes[t].count += 1;
      }

      const scored = Object.entries(themes)
        .map(([theme, d]) => ({ theme, avg: d.reach / d.count + (d.engage / d.count) * 2 }))
        .sort((a, b) => b.avg - a.avg);

      const best = scored.slice(0, 3).map((s) => s.theme);
      const worst = scored.slice(-3).map((s) => s.theme);

      await sbPatch('businesses', `id=eq.${businessId}`, {
        best_performing_themes: JSON.stringify(best),
        worst_performing_themes: JSON.stringify(worst),
      });

      const lesson = `Best themes: ${best.join(', ')}. Avoid: ${worst.join(', ')}. Based on ${perf.length} data points.`;
      await sbPost('learning_logs', {
        business_id: businessId,
        lesson_type: 'theme_performance',
        lesson_content: lesson,
        confidence_score: Math.min(perf.length / 20, 1),
        applied_at: new Date().toISOString(),
      });

      logger.info('updateLearning', businessId, 'themes updated', { best, worst });
    } catch (e) {
      logger.error('updateLearning', businessId, 'learning error', e);
    }
  }

  function requireAdminSecret(req, res, next) {
    if (!ORCHESTRATOR_SECRET) return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Admin secret not configured');
    const provided = clean(
      req.headers['x-orchestrator-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    );
    if (!timingSafeStringEqual(provided, ORCHESTRATOR_SECRET))
      return apiError(res, 401, 'UNAUTHORIZED', 'Invalid secret');
    next();
  }

  // Fan-out / cron-only endpoints iterate across ALL businesses (LLM + email
  // spend on Maroa's keys). The /webhook prefix accepts any valid Supabase JWT,
  // so without this any logged-in customer could trigger fleet-wide work. Only
  // Inngest/operator callers carrying the webhook secret (authSource==='webhook')
  // may invoke them. In-process Inngest dispatch bypasses HTTP entirely.
  function requireWebhookSource(req, res, next) {
    if (req.authSource === 'webhook') return next();
    return apiError(res, 403, 'FORBIDDEN', 'This endpoint is operator/cron only');
  }

  function safePublicError(err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('supabase') || msg.includes('sbget') || msg.includes('sbpost') || msg.includes('sbpatch'))
      return 'Data service error';
    if (msg.includes('claude') || msg.includes('anthropic') || msg.includes('openai'))
      return 'AI service temporarily unavailable';
    if (msg.includes('database') || msg.includes('sql')) return 'Service temporarily unavailable';
    return 'Service temporarily unavailable';
  }

  // requireValidUserId was previously a UUID-only gate. After the 2026-05-13
  // audit it now goes through the same JWT + ownership check as requireAnyUserId.
  // Keeping the name as a hoisted function so the 14 existing call sites work
  // unchanged — function declarations are hoisted, const is not, and call sites
  // at line ~440 use this name BEFORE module-load reaches line 2601.
  function requireValidUserId(req, res, next) {
    return requireAnyUserId(req, res, next);
  }

  app.use((req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'error')) {
        const errVal = body.error;
        const structured = errVal && typeof errVal === 'object' && typeof errVal.code === 'string';
        if (!structured && res.statusCode === 200) res.status(500);
        if (!structured && res.statusCode >= 500) {
          body = { ...body, error: safePublicError({ message: String(body.error || '') }) };
        }
      }
      return originalJson(body);
    };
    next();
  });

  async function logError(businessId, workflowName, errorMessage, retryPayload = null) {
    try {
      await sbPost('errors', {
        business_id: businessId,
        workflow_name: workflowName,
        error_message: errorMessage,
        retry_payload: retryPayload ? JSON.stringify(scrubPII(retryPayload)) : null,
      });
      if (businessId) setImmediate(() => alertOnRepeatedFailure(businessId, workflowName).catch(() => {}));
    } catch {
      /* soft-fail */
    }
  }

  // ─── UUID validation helper ──────────────────────────────────────────────────
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isUUID(v) {
    return typeof v === 'string' && UUID_RE.test(v);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ROUTES
  // ═══════════════════════════════════════════════════════════════════════════════

  // ─── GET /health — public liveness; admin detail with x-orchestrator-secret ───
  app.get('/health', (req, res) => {
    const provided = clean(
      req.headers['x-orchestrator-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    );
    let adminOk = false;
    if (ORCHESTRATOR_SECRET && provided) {
      const a = Buffer.from(provided);
      const b = Buffer.from(ORCHESTRATOR_SECRET);
      adminOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    if (!adminOk) {
      return res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        hint: 'Use /readyz for dependency readiness. Pass x-orchestrator-secret for operator detail.',
      });
    }

    const integrations = {
      anthropic: !!(ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY),
      supabase: !!SUPABASE_KEY,
      meta: !!(process.env.META_APP_ID || process.env.META_APP_SECRET),
      resend: !!RESEND_API_KEY,
      serpapi: !!SERPAPI_KEY,
      paddle: !!paddle.PADDLE_API_KEY,
      inngest: !!(process.env.INNGEST_EVENT_KEY || process.env.INNGEST_SIGNING_KEY),
    };
    const missing = Object.entries(integrations)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return res.json({
      status: missing.length <= 2 ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      integrations,
      missing_count: missing.length,
    });
  });

  app.get('/', (req, res) =>
    res.json({
      status: 'ok',
      service: 'maroa-api',
      version: '2.3.0',
      docs: 'docs/openapi.yml · /readyz · /api/billing/plans',
    })
  );

  // Debug
  app.get('/debug', requireAdminSecret, async (req, res) => {
    const out = {};
    try {
      const r = await sbGet('businesses', 'select=id&limit=1');
      out.supabase = `ok (${r.length} row)`;
    } catch (e) {
      out.supabase = `ERROR: ${e.message}`;
    }
    try {
      // eslint-disable-next-line no-restricted-syntax -- /debug health probe, 5-token ping, intentionally bypasses callClaude
      const r = await apiRequest(
        'POST',
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }
      );
      out.anthropic = r.status === 200 ? 'ok' : `ERROR ${r.status}`;
    } catch (e) {
      out.anthropic = `ERROR: ${e.message}`;
    }
    try {
      const r = await serpSearch('test', 1);
      out.serpapi = r.length ? 'ok' : 'no results (key may be invalid)';
    } catch (e) {
      out.serpapi = `ERROR: ${e.message}`;
    }

    // Meta / OAuth env vars
    const metaSecret = clean(process.env.META_APP_SECRET) || '';
    const metaAppId = clean(process.env.META_APP_ID) || '';
    out.META_APP_SECRET = metaSecret ? 'SET' : 'MISSING ❌ — set this in Railway env vars';
    out.META_APP_ID = metaAppId ? 'SET' : 'MISSING';
    out.RESEND_API_KEY = clean(process.env.RESEND_API_KEY) || '' ? 'set' : 'missing';
    out.REPLICATE_API_KEY = clean(process.env.REPLICATE_API_KEY) || '' ? 'set' : 'missing';

    res.json(out);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WF03: POST /webhook/new-user-signup — Onboarding (creates business record)
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/new-user-signup', async (req, res) => {
    // Respond immediately so the frontend doesn't time out
    res.json({ received: true });

    try {
      const {
        user_id,
        email,
        business_name,
        industry,
        website,
        first_name,
        target_audience,
        main_goal,
        platforms,
        monthly_budget,
        posting_frequency,
        plan = 'free',
      } = req.body;

      log('/webhook/new-user-signup', `user_id=${user_id} email=${email} business=${business_name}`);

      if (!email && !user_id) {
        log('/webhook/new-user-signup', 'Missing email and user_id — skipping');
        return;
      }

      // Identity binding: a JWT caller's identity comes from the verified token,
      // NOT the request body — otherwise an attacker could pass a victim's
      // user_id/email and overwrite their business (IDOR). Only the trusted
      // webhook-secret path (onboarding orchestrator) may name the target in the body.
      const isJwtCaller = req.authSource === 'jwt';
      const boundUserId = isJwtCaller ? req.user?.id || null : user_id;
      const boundEmail = isJwtCaller ? req.user?.email || email : email;
      if (isJwtCaller && !boundUserId) {
        log('/webhook/new-user-signup', 'JWT caller without a token user id — skipping');
        return;
      }
      if (boundUserId && !isUUID(String(boundUserId))) {
        log('/webhook/new-user-signup', 'Invalid user_id — skipping');
        return;
      }

      // ── Check if business already exists for this user ──────────────────────
      let bizId = null;

      // Try by (bound) user_id first — encoded per Rule 4.
      if (boundUserId) {
        const existing = await sbGet('businesses', `user_id=eq.${encodeURIComponent(boundUserId)}&select=id`);
        if (existing[0]) {
          bizId = existing[0].id;
          log('/webhook/new-user-signup', `Found existing business by user_id: ${bizId}`);
        }
      }

      // Email fallback is only safe for the trusted webhook path; a JWT caller
      // must not be able to locate a business by an arbitrary email.
      if (!bizId && boundEmail && !isJwtCaller) {
        const existing = await sbGet('businesses', `email=eq.${encodeURIComponent(boundEmail)}&select=id`);
        if (existing[0]) {
          bizId = existing[0].id;
          log('/webhook/new-user-signup', `Found existing business by email: ${bizId}`);
        }
      }

      // ── Build the data object (remove undefined values) ────────────────────
      const bizData = {
        business_name: business_name,
        industry: industry,
        website_url: website,
        target_audience: target_audience,
        marketing_goal: main_goal,
        selected_platforms: Array.isArray(platforms) ? JSON.stringify(platforms) : platforms,
        monthly_budget: monthly_budget,
        posting_frequency: posting_frequency,
        onboarding_complete: true,
        autopilot_enabled: true,
      };
      Object.keys(bizData).forEach((k) => bizData[k] === undefined && delete bizData[k]);

      if (bizId) {
        // ── Update existing business ───────────────────────────────────────────
        await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, bizData);
        log('/webhook/new-user-signup', `Updated existing business: ${bizId}`);
      } else {
        // ── Create new business ────────────────────────────────────────────────
        const insertData = {
          ...bizData,
          user_id: boundUserId,
          email: boundEmail,
          first_name: first_name,
          plan: plan,
          is_active: true,
          created_at: new Date().toISOString(),
        };
        Object.keys(insertData).forEach((k) => insertData[k] === undefined && delete insertData[k]);

        const created = await sbPost('businesses', insertData);
        bizId = created?.id;
        log('/webhook/new-user-signup', `Created new business: ${bizId}`);
      }

      if (!bizId) {
        log('/webhook/new-user-signup', 'ERROR: Could not create or find business');
        return;
      }

      // ── Run background enrichment (non-blocking, errors are just warnings) ──

      // Brand voice extraction from website
      if (website) {
        try {
          const brandVoice = await callClaude(
            `Analyze this business website: ${website}\n` +
              `Extract: voice_adjectives (3 words), writing_style, key_phrases, usp, target_person, emotional_tone.\n` +
              `Return only valid JSON.`,
            'research',
            1000
          );
          if (brandVoice && !brandVoice._raw) {
            await sbPatch('businesses', `id=eq.${bizId}`, { brand_voice_locked: JSON.stringify(brandVoice) });
            log('/webhook/new-user-signup', `Brand voice extracted for ${bizId}`);
          }
        } catch (e) {
          log('/webhook/new-user-signup', `Brand voice WARN: ${e.message}`);
        }
      }

      // Welcome email
      if (email) {
        try {
          const firstName = first_name || business_name || 'there';
          const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
<div style="background:linear-gradient(135deg,#0A84FF,#BF5AF2);padding:40px;border-radius:16px;text-align:center;margin-bottom:30px">
  <h1 style="color:white;margin:0;font-size:28px">Welcome to Maroa AI, ${firstName}!</h1>
  <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:16px">Your AI marketing team is ready</p>
</div>
<p style="color:#555;font-size:16px;line-height:1.6">Your business <strong>${business_name}</strong> is all set up. Head to your dashboard to see your AI marketing engine in action.</p>
<div style="text-align:center;margin:30px 0">
  <a href="https://maroa.ai/dashboard" style="background:#0A84FF;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:bold;font-size:16px">Open Dashboard</a>
</div>
</body></html>`;
          await sendEmail(email, `Welcome ${firstName}! Your AI marketing is live`, html);
          log('/webhook/new-user-signup', `Welcome email sent to ${email}`);
        } catch (e) {
          log('/webhook/new-user-signup', `Email WARN: ${e.message}`);
        }
      }

      log('/webhook/new-user-signup', `✅ Complete for ${business_name} (${bizId})`);
    } catch (err) {
      logger.error('/webhook/new-user-signup', null, 'handler error', err, { request_id: req.requestId });
      try {
        await logError(null, 'new-user-signup', err.message, req.body);
      } catch (_) {
        /* soft-fail */
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Core content generation function (shared by signup + instant-content)
  // ─────────────────────────────────────────────────────────────────────────────
  async function generateInstantContent(bizId, emailOverride) {
    // Fetch all context (including new business_profiles for master prompt)
    const [bizArr, recentContent, compInsights, learningArr, profileArr] = await Promise.all([
      sbGet('businesses', `id=eq.${bizId}&select=*`),
      sbGet('generated_content', `business_id=eq.${bizId}&order=created_at.desc&limit=5`),
      sbGet('competitor_insights', `business_id=eq.${bizId}&order=recorded_at.desc&limit=1`),
      sbGet('learning_logs', `business_id=eq.${bizId}&order=created_at.desc&limit=1`),
      sbGet('business_profiles', `user_id=eq.${bizId}&select=*`).catch(() => []),
    ]);

    const biz = bizArr[0];
    if (!biz) throw new Error(`Business ${bizId} not found`);

    const perfThemesBlock = await fetchPerformanceThemesContextBlock(bizId);

    // If rich profile exists, build master prompt for enhanced accuracy
    const profile = profileArr[0] || null;
    let masterSystemPrompt = '';
    if (
      profile &&
      profile.physical_locations &&
      Array.isArray(profile.physical_locations) &&
      profile.physical_locations.length > 0
    ) {
      try {
        const extraCtx = perfThemesBlock ? `${perfThemesBlock}` : '';
        const cacheSubject = profile.user_id || bizId;
        masterSystemPrompt = await getCachedMasterPrompt(cacheSubject, profile, 'social_post', extraCtx);
        log(
          'generateContent',
          `Using master prompt + marketing skills for ${biz.business_name} (profile score: ${profile.profile_score})`
        );
      } catch (e) {
        // Fallback to basic master prompt without skills
        try {
          const { buildMasterPrompt: bmp } = require('./services/masterPromptBuilder');
          masterSystemPrompt = bmp(profile, 'social_post') + (perfThemesBlock ? `\n\n${perfThemesBlock}\n\n` : '\n\n');
        } catch {
          /* soft-fail */
        }
        log('generateContent', `Master prompt fallback (skills unavailable): ${e.message}`);
      }
    } else if (perfThemesBlock) {
      masterSystemPrompt = `${perfThemesBlock}\n\n`;
    }

    const comp = compInsights[0];
    const lesson = learningArr[0];
    const nowDate = new Date();
    const month = nowDate.toLocaleString('default', { month: 'long' });

    const platforms = (() => {
      try {
        return JSON.parse(biz.selected_platforms || '[]').join(', ') || 'Instagram, Facebook';
      } catch {
        return 'Instagram, Facebook';
      }
    })();

    const bestThemes = (() => {
      try {
        return JSON.parse(biz.best_performing_themes || '[]').join(', ') || 'None yet';
      } catch {
        return 'None yet';
      }
    })();
    const worstThemes = (() => {
      try {
        return JSON.parse(biz.worst_performing_themes || '[]').join(', ') || 'None yet';
      } catch {
        return 'None yet';
      }
    })();
    const aiBrain = (() => {
      try {
        return JSON.stringify(JSON.parse(biz.ai_brain_decisions || '{}'));
      } catch {
        return 'No decisions yet';
      }
    })();
    const brandVoice = biz.brand_voice_locked || biz.brand_tone || 'professional, warm, helpful';

    const recentThemes =
      recentContent
        .map((c) => c.content_theme)
        .filter(Boolean)
        .join(', ') || 'None yet';

    // ── UPGRADE 3: Fetch brand memory examples + latest competitor report ──
    const brandContext = await getBrandExamples(
      bizId,
      'social_post',
      `${biz.business_name} ${biz.industry || ''} marketing`
    );
    let competitorReport = '';
    try {
      const compReports = await sbGet('competitor_reports', `business_id=eq.${bizId}&order=created_at.desc&limit=1`);
      if (compReports[0]?.recommendation) {
        competitorReport = `LATEST COMPETITOR REPORT RECOMMENDATION:\n${compReports[0].recommendation}\n\n`;
      }
    } catch {
      /* soft-fail */
    }

    // P0-1 (audit 2026-05-20): Plug the closed-loop creative system into
    // instant generation. Grounding context injects wins/losses/VoC/cohort/
    // brand voice + voice_seed (P0-2) so day-1 drafts are anchored in real
    // signal, not generic placeholders. Falls back gracefully on any error
    // — the rest of the prompt construction still runs.
    let groundingBlock = '';
    try {
      const groundingLib = require('./lib/groundingContext');
      const groundingCtx = await groundingLib.buildGroundingContext({
        sbGet,
        businessId: bizId,
        surface: 'social_post',
        intent: 'conversion',
        limit: 3,
        plan: biz.plan,
        // Use the business name + industry as the semantic anchor when
        // performanceMemory is configured; falls back to recency-based wins
        // when not. Either way we get something better than no grounding.
        semanticQuery: `${biz.business_name || ''} ${biz.industry || ''} ${biz.marketing_goal || ''}`.trim(),
      });
      if (!groundingCtx.isEmpty()) {
        groundingBlock = `${groundingCtx.toPromptBlock()}\n\n`;
      }
    } catch (gcErr) {
      log('generateContent', `grounding context failed (non-fatal): ${gcErr.message}`);
    }

    const prompt =
      groundingBlock +
      `${masterSystemPrompt}${brandContext}${competitorReport}You are the AI marketing brain for ${biz.business_name}. Here is everything you know:\n\n` +
      `BRAND VOICE (LOCKED — use this exact voice in EVERY piece): ${brandVoice}\n` +
      `DREAM CUSTOMER: ${biz.dream_customer || biz.target_audience || 'General audience'}\n` +
      `UNIQUE DIFFERENTIATOR: ${biz.unique_differentiator || 'To be highlighted'}\n` +
      `CUSTOMER PAIN POINTS: ${biz.customer_pain_points || 'Unknown'}\n` +
      `PRIMARY GOAL: ${biz.primary_goal || biz.marketing_goal || 'Grow brand awareness'}\n` +
      `INDUSTRY: ${biz.industry || 'General'} | LOCATION: ${biz.city || ''} ${biz.state || ''}\n\n` +
      `PERFORMANCE INTELLIGENCE:\n` +
      `- Best performing themes (create MORE like these): ${bestThemes}\n` +
      `- Worst performing themes (AVOID completely): ${worstThemes}\n` +
      `- Recent content themes used: ${recentThemes}\n\n` +
      `COMPETITOR INTELLIGENCE:\n` +
      `- What they do well: ${comp?.competitor_doing_well || 'Researching...'}\n` +
      `- Gap we can exploit: ${comp?.gap_opportunity || 'Analyzing...'}\n` +
      `- Content angle to steal: ${comp?.content_to_steal || 'Research needed'}\n` +
      `- Positioning tip: ${comp?.positioning_tip || 'Stay authentic'}\n\n` +
      `AI BRAIN DECISIONS (follow these): ${aiBrain}\n` +
      `LATEST LEARNING (apply this): ${lesson?.lesson_content || 'Still gathering data'}\n\n` +
      `TIMING CONTEXT:\n` +
      `- Current month: ${month} | Season: ${getSeason()}\n` +
      `- Upcoming holidays: ${getUpcomingHolidays()}\n\n` +
      `PLATFORMS TO CREATE FOR: ${platforms}\n\n` +
      `QUALITY REQUIREMENTS (non-negotiable):\n` +
      `- Instagram: minimum 3 emojis + 5 hashtags + ends with a question\n` +
      `- Facebook: minimum 100 words + conversation starter + community feel\n` +
      `- LinkedIn: professional insight + data point + call to action\n` +
      `- TikTok: hook in first 3 words + body + strong CTA\n` +
      `- Google Headline: benefit-led, UNDER 30 characters\n` +
      `- Google Description: specific, UNDER 90 characters\n` +
      `- Email subject: under 50 characters, curiosity-driven\n\n` +
      `Generate a COMPLETE week of content. If any piece fails the quality check above, rewrite it.\n` +
      `Return ONLY valid JSON:\n` +
      `{"instagram_caption":"...","instagram_caption_2":"...","facebook_post":"...","instagram_story_text":"...",` +
      `"linkedin_post":"...","tiktok_script":"...","email_subject":"...","email_body":"...",` +
      `"blog_title":"...","google_ad_headline":"...","google_ad_description":"...","content_theme":"...","image_prompt":"..."}`;

    const bizClaude = { businessId: bizId };
    let content = await callClaude(prompt, 'social_post', 3000, bizClaude);
    let score = scoreContent(content);

    // ── UPGRADE 3: Generate 3 variations, pick the highest scoring one ────
    const variations = [{ content, score }];
    if (score < 90 && !content._raw) {
      // Generate 2 more variations in parallel
      const [v2, v3] = await Promise.all([
        callClaude(
          prompt + `\n\nVARIATION 2: Use a completely different angle, hook, and content theme. Be creative and bold.`,
          'social_post',
          3000,
          bizClaude
        ).catch(() => null),
        callClaude(
          prompt + `\n\nVARIATION 3: Focus on storytelling and emotion. Make the audience FEEL something.`,
          'social_post',
          3000,
          bizClaude
        ).catch(() => null),
      ]);
      if (v2 && !v2._raw) variations.push({ content: v2, score: scoreContent(v2) });
      if (v3 && !v3._raw) variations.push({ content: v3, score: scoreContent(v3) });
      // Pick the winner
      variations.sort((a, b) => b.score - a.score);
      content = variations[0].content;
      score = variations[0].score;
      log(
        'generateContent',
        `3-variation contest: scores=[${variations.map((v) => v.score).join(',')}] winner=${score}`
      );
    }

    // Generate image via smart model router (plan-aware)
    const imgPrompt =
      content.image_prompt || `Professional marketing photo for ${biz.business_name}, ${biz.industry || 'business'}`;
    const imgResult = await generateSmartImage(bizId, imgPrompt, 'social_post', biz.plan || 'free');

    // ── Content Validation + repair pass ───────────────────────────────────────
    const profileForVal = {
      ...biz,
      ...profile,
      physical_locations: profile?.physical_locations,
      ad_targeting_area: profile?.ad_targeting_area,
      primary_language: profile?.primary_language || 'English',
      business_name: biz.business_name,
      words_never_use: profile?.words_never_use,
      never_do: profile?.never_do,
    };
    let gateStatus = 'approved';
    try {
      const { validateContent } = require('./services/contentValidator');
      const mainText = content.instagram_caption || content.facebook_post || '';
      let validation = validateContent(mainText, profileForVal, 'social_post');
      if (!validation.valid && validation.issues.length > 0) {
        log('contentValidator', `Issues found: ${validation.issues.join(', ')} — repair pass...`);
        const fixPrompt =
          prompt +
          `\n\nPREVIOUS ATTEMPT HAD THESE ISSUES — FIX THEM:\n${validation.issues.join('\n')}\nGenerate corrected JSON only.`;
        const fixed = await callClaude(fixPrompt, 'social_post', 3000, bizClaude);
        if (fixed && !fixed._raw) {
          content = fixed;
          score = scoreContent(content);
          const t2 = content.instagram_caption || content.facebook_post || '';
          validation = validateContent(t2, profileForVal, 'social_post');
        }
        if (!validation.valid) {
          gateStatus = 'needs_review';
          log('contentValidator', `Still invalid after repair: ${validation.issues.join(', ')}`);
        }
      }
      content._quality_score = validation.quality_score;
    } catch (valErr) {
      log('contentValidator', `Validation skipped: ${valErr.message}`);
    }

    let strategy_reason = '';
    try {
      const igText = (content.instagram_caption || content.facebook_post || '').trim();
      if (igText.length > 20) {
        const reasonRaw = await callClaude(
          `In one sentence (max 15 words), explain the marketing strategy behind this post: "${igText.slice(0, 200).replace(/"/g, '\\"')}"`,
          'caption',
          200,
          {
            returnRaw: true,
            system:
              'You are a marketing strategist. Be specific and brief. Output one sentence only, plain text, no JSON.',
            businessId: bizId,
          }
        );
        strategy_reason = typeof reasonRaw === 'string' ? reasonRaw.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
      }
    } catch (e) {
      log('strategy_reason', e.message);
    }

    // ── LEVEL 6: Automated A/B testing — save both winner (A) and runner-up (B) ─
    let abTestId = null;
    const runnerUp = variations.length > 1 ? variations[1] : null;
    if (runnerUp) {
      try {
        const testRow = await sbPost('ab_tests', {
          business_id: bizId,
          variant_a: JSON.stringify({
            theme: content.content_theme,
            caption: (content.instagram_caption || '').slice(0, 500),
          }),
          variant_b: JSON.stringify({
            theme: runnerUp.content.content_theme,
            caption: (runnerUp.content.instagram_caption || '').slice(0, 500),
          }),
          started_at: new Date().toISOString(),
        });
        abTestId = testRow?.id || null;
      } catch {
        /* soft-fail */
      }
    }

    // P1-4 (audit 2026-05-20): Structured reasoning trace. Powers the
    // dashboard's "why?" panel + ops dashboards. Migration 078 added the
    // column. We capture everything the model was anchored on at gen time
    // so future questions like "why did this draft win?" have an answer.
    const reasoningTrace = {
      generated_at: new Date().toISOString(),
      grounding_used: !!groundingBlock,
      grounding_chars: groundingBlock.length,
      variation_count: variations.length,
      variation_scores: variations.map((v) => v.score),
      winning_score: score,
      quality_gate: gateStatus || null,
      image_source: imgResult.source || null,
      image_model: imgResult.model || null,
      voice_seed_used: !!(biz.voice_seed && biz.voice_seed.trim()),
      industry: biz.industry || null,
      plan: biz.plan || null,
    };

    // Save to generated_content (Variant A — winner)
    const saved = await sbPost('generated_content', {
      business_id: bizId,
      instagram_caption: content.instagram_caption || '',
      instagram_caption_2: content.instagram_caption_2 || '',
      facebook_post: content.facebook_post || '',
      instagram_story_text: content.instagram_story_text || '',
      email_subject: content.email_subject || '',
      email_body: content.email_body || '',
      blog_title: content.blog_title || '',
      google_ad_headline: content.google_ad_headline || '',
      google_ad_description: content.google_ad_description || '',
      content_theme: content.content_theme || '',
      image_url: imgResult.url || '',
      image_source: imgResult.source || '',
      image_credit: imgResult.credit || '',
      strategy_reason: strategy_reason || null,
      reasoning_trace: reasoningTrace,
      status: gateStatus === 'needs_review' ? 'needs_review' : 'approved',
      variant: 'A',
      ab_test_id: abTestId,
      pre_post_score: score,
    });

    // Save Variant B for evening posting if A/B test exists
    if (runnerUp && abTestId) {
      try {
        await sbPost('generated_content', {
          business_id: bizId,
          instagram_caption: runnerUp.content.instagram_caption || '',
          facebook_post: runnerUp.content.facebook_post || '',
          email_subject: runnerUp.content.email_subject || '',
          content_theme: runnerUp.content.content_theme || '',
          image_url: imgResult.url || '',
          status: gateStatus === 'needs_review' ? 'needs_review' : 'approved',
          variant: 'B',
          ab_test_id: abTestId,
          pre_post_score: runnerUp.score,
          scheduled_for: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(), // evening
        });
      } catch {
        /* soft-fail */
      }
    }

    log(
      'generateContent',
      `✅ saved row ${saved?.id} score=${score} theme="${content.content_theme}" img=${imgResult.source}`
    );

    // Update learning data after every generation
    setImmediate(() => updateLearning(bizId));

    // ── Performance feedback loop: check engagement 24h after publish ─────
    // PRIOR: this used an in-process setTimeout(24h). That callback was lost
    // on every Railway redeploy — so the feedback loop only fired for posts
    // published in the last ~24h of a deploy's uptime, silently dropping the
    // rest. Now we emit an Inngest event and the durable scheduler handles
    // the 24h sleep + execution, surviving redeploys.
    if (saved?.id && biz.meta_access_token && biz.facebook_page_id) {
      try {
        const { inngest } = require('./services/inngest/client');
        await inngest.send({
          name: 'maroa/content.publish.feedback-24h',
          data: { contentId: saved.id, businessId: bizId },
        });
      } catch (err) {
        log('feedback-loop', `inngest send failed (will retry on next publish): ${err.message}`);
      }
    }

    return { ...content, row_id: saved?.id, quality_score: score, image: imgResult };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WF15: POST /webhook/instant-content
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/instant-content', async (req, res) => {
    const { business_id, email } = req.body;
    logger.info('/webhook/instant-content', business_id || null, 'request received', { request_id: req.requestId });

    if (!business_id) return apiError(res, 400, 'VALIDATION_ERROR', 'business_id required');

    const rl = await checkRateLimit(String(business_id || req.ip));
    if (!rl.success) return apiError(res, 429, 'RATE_LIMITED', 'Too many requests — please wait 1 minute');

    // Return immediately — content generation + email happen in background
    res.json({ received: true, message: 'Content generation started — check email in ~2 minutes' });

    setImmediate(async () => {
      try {
        const result = await generateInstantContent(business_id, email);

        if (email) {
          const html = `<h2>Your weekly content is ready!</h2>
<p>Theme: <strong>${result.content_theme || 'Weekly Content'}</strong></p>
<p>Quality Score: <strong>${result.quality_score}/100</strong></p>
<p>All platforms ready: Instagram, Facebook, LinkedIn, TikTok, Google Ads, Email</p>
<p><a href="https://maroa.ai" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve Content</a></p>`;
          await sendEmail(email, `Your ${result.content_theme || 'weekly'} content is ready!`, html);
        }
        try {
          storeInsight(
            business_id,
            'content',
            'content_performance',
            'top_content_type',
            `${result.content_theme || 'general'}: ${(result.instagram_caption || '').slice(0, 80)}`
          );
        } catch {
          /* soft-fail */
        }
        logger.info('/webhook/instant-content', business_id, 'generation complete', {
          theme: result.content_theme,
          request_id: req.requestId,
        });
      } catch (err) {
        logger.error('/webhook/instant-content', business_id, 'generation failed', err, { request_id: req.requestId });
        await logError(business_id, 'instant-content', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WF10: POST /webhook/account-connected
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/account-connected', async (req, res) => {
    const { business_id, meta_access_token, linkedin_access_token, tiktok_access_token, google_access_token } =
      req.body;
    logger.info('/webhook/account-connected', business_id || null, 'request received', { request_id: req.requestId });

    if (!business_id) return apiError(res, 400, 'VALIDATION_ERROR', 'business_id required');
    res.json({ received: true, message: 'Account connections being processed' });

    try {
      const updates = { social_accounts_connected: true };
      const connected = [];

      // ── Facebook + Instagram ──────────────────────────────────────────────────
      if (meta_access_token) {
        try {
          // Step A: check if this is a user token or page token
          const debugResp = await apiRequest(
            'GET',
            `https://graph.facebook.com/v19.0/debug_token?input_token=${meta_access_token}&access_token=${meta_access_token}`
          );
          const tokenType = debugResp.body?.data?.type; // "USER" or "PAGE"
          const granular = debugResp.body?.data?.granular_scopes || [];
          log('/webhook/account-connected', `Token type: ${tokenType}`);

          // Step B: if user token, exchange for page token via /me/accounts
          let pageToken = meta_access_token;
          let pageId = req.body.facebook_page_id || null;
          let pageName = '';
          let fanCount = 0;

          if (tokenType === 'USER' || !tokenType) {
            const pagesResp = await apiRequest(
              'GET',
              `https://graph.facebook.com/v19.0/me/accounts?access_token=${meta_access_token}&fields=id,name,access_token,fan_count`
            );
            const pages = pagesResp.body?.data || [];
            // If a specific page ID was passed, match it; otherwise take the first page
            const page = pageId ? pages.find((p) => p.id === pageId) || pages[0] : pages[0];

            if (page) {
              pageToken = page.access_token; // real page token — never expires
              pageId = page.id;
              pageName = page.name;
              fanCount = page.fan_count || 0;
              log('/webhook/account-connected', `Exchanged to page token for: ${page.name} (${page.id})`);
            }
          } else if (tokenType === 'PAGE') {
            // Already a page token — extract page ID from debug data
            pageId = debugResp.body?.data?.profile_id || pageId;
            pageName = 'Maroa.ai';
          }

          // Save page token (not user token)
          updates.meta_access_token = pageToken;
          if (pageId) updates.facebook_page_id = pageId;
          if (fanCount) updates.followers_gained = fanCount;
          if (pageName) connected.push(`Facebook (${pageName})`);
          else if (pageId) connected.push(`Facebook`);

          // Step C: get Instagram ID
          // Try 1: page fields
          let igId = null;
          if (pageId) {
            const igPageResp = await apiRequest(
              'GET',
              `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account,connected_instagram_account&access_token=${pageToken}`
            );
            igId =
              igPageResp.body?.instagram_business_account?.id ||
              igPageResp.body?.connected_instagram_account?.id ||
              null;
          }

          // Try 2: extract from token's granular_scopes (instagram_basic target_ids)
          if (!igId) {
            const igScope = granular.find((s) => s.scope === 'instagram_basic');
            igId = igScope?.target_ids?.[0] || null;
            if (igId) log('/webhook/account-connected', `Got IG ID from granular_scopes: ${igId}`);
          }

          if (igId) {
            updates.instagram_account_id = igId;
            connected.push('Instagram');
          }
        } catch (e) {
          log('/webhook/account-connected', `FB warn: ${e.message}`);
        }
      }

      // ── LinkedIn ──────────────────────────────────────────────────────────────
      if (linkedin_access_token) {
        updates.linkedin_access_token = linkedin_access_token;
        try {
          const liResp = await apiRequest('GET', 'https://api.linkedin.com/v2/me', {
            Authorization: `Bearer ${linkedin_access_token}`,
          });
          if (liResp.status === 200) {
            updates.linkedin_page_id = liResp.body?.id || '';
            connected.push('LinkedIn');
          }
        } catch (e) {
          log('/webhook/account-connected', `LinkedIn warn: ${e.message}`);
        }
      }

      // ── TikTok ────────────────────────────────────────────────────────────────
      if (tiktok_access_token) {
        updates.tiktok_access_token = tiktok_access_token;
        connected.push('TikTok');
      }

      // ── Google ────────────────────────────────────────────────────────────────
      if (google_access_token) {
        updates.google_access_token = google_access_token;
        if (req.body.google_ads_customer_id) updates.google_ads_customer_id = req.body.google_ads_customer_id;
        connected.push('Google');
      }

      await sbPatch('businesses', `id=eq.${business_id}`, updates);

      // Log onboarding event
      await sbPost('onboarding_events', {
        business_id,
        event_type: 'account_connected',
        event_data: JSON.stringify({ connected, timestamp: new Date().toISOString() }),
      });

      log('/webhook/account-connected', `✅ Connected: ${connected.join(', ')}`);

      // Trigger campaign creation if budget set
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=daily_budget,meta_access_token,email`))[0];
      if ((biz?.daily_budget || 0) > 0 && (updates.meta_access_token || biz?.meta_access_token)) {
        setImmediate(async () => {
          try {
            const r = await apiRequest(
              'POST',
              `http://localhost:${PORT}/webhook/create-campaigns`,
              { 'Content-Type': 'application/json' },
              { business_id }
            );
            log('/webhook/account-connected', `Campaigns triggered: ${r.status}`);
          } catch {
            /* soft-fail */
          }
        });
      }

      // Send connected email
      if (biz?.email) {
        const html = `<h2>Platforms Connected!</h2><p>You've successfully connected: <strong>${connected.join(', ')}</strong></p>
<p>Your AI will now post automatically and track performance across all platforms.</p>
<p><a href="https://maroa.ai" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Dashboard</a></p>`;
        await sendEmail(
          biz.email,
          `${connected.length} platform${connected.length > 1 ? 's' : ''} connected to maroa.ai!`,
          html
        );
      }
    } catch (err) {
      console.error('[account-connected ERROR]', err.message);
      await logError(business_id, 'account-connected', err.message, req.body);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WF29: POST /webhook/create-campaigns
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/create-campaigns', async (req, res) => {
    const { business_id } = req.body;
    log('/webhook/create-campaigns', `business_id=${business_id}`);

    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'Campaign creation started' });

    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=*`))[0];
      if (!biz) throw new Error('Business not found');

      const campaignPrompt =
        `Create 3 Meta ad campaigns for ${biz.business_name}, a ${biz.business_type || biz.industry} in ${biz.city || ''} ${biz.state || ''}.\n` +
        `Primary goal: ${biz.primary_goal || biz.marketing_goal || 'grow brand awareness'}.\n` +
        `Dream customer: ${biz.dream_customer || biz.target_audience || 'local consumers'} aged ${biz.target_age_min || 18}-${biz.target_age_max || 65}.\n` +
        `Monthly budget: $${biz.monthly_budget || 300} split across 3 campaigns.\n\n` +
        `Campaign 1: AWARENESS — cold audiences matching dream customer profile\n` +
        `Campaign 2: ENGAGEMENT — page fans and 1% lookalike audiences\n` +
        `Campaign 3: RETARGETING — website visitors and past customers\n\n` +
        `For each provide: campaign_name, objective, daily_budget (number), audience_description,\n` +
        `ad_headline (under 30 chars), ad_description (under 90 chars), call_to_action,\n` +
        `targeting_interests (array), targeting_age_min, targeting_age_max, targeting_gender.\n` +
        `Return ONLY a valid JSON array with exactly 3 campaign objects.`;

      const campaigns = await callClaude(campaignPrompt, 'social_post', 1500);
      const campaignList = Array.isArray(campaigns) ? campaigns : campaigns?.campaigns || [campaigns];

      const objectives = ['REACH', 'POST_ENGAGEMENT', 'LINK_CLICKS'];
      const savedIds = [];

      for (let i = 0; i < Math.min(campaignList.length, 3); i++) {
        const c = campaignList[i];
        const saved = await sbPost('ad_campaigns', {
          business_id,
          business_name: biz.business_name,
          status: 'pending',
          daily_budget: c.daily_budget || Math.floor((biz.daily_budget || 10) * [0.4, 0.25, 0.35][i]),
          last_decision: 'Created by AI',
          last_decision_reason: c.campaign_name || `Campaign ${i + 1}`,
        });
        savedIds.push(saved?.id);

        // Create on Meta Marketing API if token available
        if (biz.meta_access_token && biz.ad_account_id) {
          try {
            const metaResp = await externalHttp(
              apiRequest,
              'POST',
              `https://graph.facebook.com/v19.0/act_${biz.ad_account_id}/campaigns`,
              { 'Content-Type': 'application/json' },
              {
                name: c.campaign_name || `Maroa ${['Awareness', 'Engagement', 'Retargeting'][i]}`,
                objective: objectives[i],
                status: 'PAUSED',
                special_ad_categories: [],
                access_token: biz.meta_access_token,
              }
            );
            if (metaResp.body?.id && saved?.id) {
              await sbPatch('ad_campaigns', `id=eq.${saved.id}`, {
                meta_campaign_id: metaResp.body.id,
                status: 'active',
              });
            }
          } catch (e) {
            log('/webhook/create-campaigns', `Meta API warn: ${e.message}`);
          }
        }
      }

      try {
        storeInsight(business_id, 'ads', 'ad_strategy', 'campaign_count', `${savedIds.length} campaigns created`);
      } catch {
        /* soft-fail */
      }
      log('/webhook/create-campaigns', `✅ Created ${savedIds.length} campaigns`);

      if (biz.email) {
        const html = `<h2>Your Ad Campaigns Are Ready!</h2>
<p>We've created 3 optimized Meta ad campaigns for <strong>${biz.business_name}</strong>:</p>
<ul><li>Awareness Campaign (40% budget)</li><li>Engagement Campaign (25% budget)</li><li>Retargeting Campaign (35% budget)</li></ul>
<p>All campaigns are set to PAUSED — activate them when ready in your dashboard.</p>
<p><a href="https://maroa.ai" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Manage Campaigns</a></p>`;
        await sendEmail(biz.email, `Your ad campaigns are ready, ${biz.first_name || biz.business_name}!`, html);
      }
    } catch (err) {
      console.error('[create-campaigns ERROR]', err.message);
      await logError(business_id, 'create-campaigns', err.message, req.body);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/content-approved — autopublish to Facebook + Instagram
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/content-approved', async (req, res) => {
    const { content_id, business_id, approval_method } = req.body;
    logger.info('/webhook/content-approved', business_id || null, 'webhook received', {
      content_id,
      request_id: req.requestId,
    });

    if (!content_id) return apiError(res, 400, 'VALIDATION_ERROR', 'content_id required');
    if (!isUUID(String(content_id))) return apiError(res, 400, 'VALIDATION_ERROR', 'content_id must be a valid UUID');
    // business_id is required: the /webhook owner gate verifies the caller owns
    // it, and we then bind content_id to it below so a caller can't approve or
    // publish another tenant's content by passing a foreign content_id.
    if (!business_id || !isUUID(String(business_id)))
      return apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');

    // Return immediately — DB update + publishing happen in background
    res.json({ received: true, message: 'Approved — autopublish in progress' });

    setImmediate(async () => {
      try {
        const encContent = encodeURIComponent(content_id);
        const encBiz = encodeURIComponent(business_id);
        const [bizArr, contentArr] = await Promise.all([
          sbGet('businesses', `id=eq.${encBiz}&select=*`),
          sbGet('generated_content', `id=eq.${encContent}&select=*`),
        ]);
        const biz = bizArr[0];
        const cont = contentArr[0];
        if (!biz || !cont) {
          log('/webhook/content-approved', 'biz/content not found — skipping publish');
          return;
        }
        // Tenant binding: the content must belong to the verified business.
        if (String(cont.business_id) !== String(business_id)) {
          logger.warn('/webhook/content-approved', business_id, 'content_id does not belong to business — blocked', {
            content_id,
          });
          return;
        }
        await sbPatch('generated_content', `id=eq.${encContent}&business_id=eq.${encBiz}`, {
          status: 'approved',
          approved_at: new Date().toISOString(),
          approval_method: approval_method || 'manual',
        });

        const platforms = (() => {
          try {
            return JSON.parse(biz.selected_platforms || '[]');
          } catch {
            return [];
          }
        })();
        const published = [];

        // ── Publish to Facebook ───────────────────────────────────────────────────
        if (
          biz.autopilot_enabled &&
          biz.meta_access_token &&
          biz.facebook_page_id &&
          (platforms.includes('facebook') || platforms.length === 0)
        ) {
          try {
            const fbResp = await externalHttp(
              apiRequest,
              'POST',
              `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/feed`,
              { 'Content-Type': 'application/json' },
              {
                message: cont.facebook_post || cont.instagram_caption,
                access_token: biz.meta_access_token,
                ...(cont.image_url ? { link: cont.image_url } : {}),
              }
            );
            if (fbResp.body?.id) {
              published.push('Facebook');
              log('/webhook/content-approved', `FB posted: ${fbResp.body.id}`);
            }
          } catch (e) {
            log('/webhook/content-approved', `FB warn: ${e.message}`);
          }
        }

        // ── Publish to Instagram ──────────────────────────────────────────────────
        if (
          biz.autopilot_enabled &&
          biz.meta_access_token &&
          biz.instagram_account_id &&
          (platforms.includes('instagram') || platforms.length === 0)
        ) {
          try {
            if (cont.image_url) {
              const step1 = await externalHttp(
                apiRequest,
                'POST',
                `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media`,
                { 'Content-Type': 'application/json' },
                { image_url: cont.image_url, caption: cont.instagram_caption, access_token: biz.meta_access_token }
              );

              if (step1.body?.id) {
                const step2 = await externalHttp(
                  apiRequest,
                  'POST',
                  `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media_publish`,
                  { 'Content-Type': 'application/json' },
                  { creation_id: step1.body.id, access_token: biz.meta_access_token }
                );
                if (step2.body?.id) {
                  published.push('Instagram');
                  log('/webhook/content-approved', `IG posted: ${step2.body.id}`);
                }
              }
            }
          } catch (e) {
            log('/webhook/content-approved', `IG warn: ${e.message}`);
          }
        }

        if (published.length > 0) {
          await sbPatch('generated_content', `id=eq.${content_id}`, {
            status: 'published',
            published_at: new Date().toISOString(),
          });
          await sbPatch('businesses', `id=eq.${business_id}`, { posts_published: (biz.posts_published || 0) + 1 });
          await sbPost('retention_logs', {
            business_id,
            email_type: 'content_published',
            subject: `Published: ${cont.content_theme || 'content'} to ${published.join(', ')}`,
          });
        }

        log('/webhook/content-approved', `✅ Published to: ${published.join(', ') || 'none (manual only)'}`);
      } catch (err) {
        console.error('[content-approved ERROR]', err.message);
        await logError(business_id, 'content-approved', err.message, req.body).catch(() => {});
      }
    }); // end setImmediate
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/budget-updated
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/budget-updated', async (req, res) => {
    const { business_id, daily_budget, new_budget } = req.body;
    const budget = daily_budget || new_budget;
    log('/webhook/budget-updated', `business_id=${business_id} budget=${budget}`);

    if (!business_id || budget === undefined) return res.status(400).json({ error: 'business_id and budget required' });
    res.json({ received: true, message: 'Budget update processing' });

    try {
      await sbPatch('businesses', `id=eq.${business_id}`, { daily_budget: budget });

      const [bizArr, campaigns] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=*`),
        sbGet('ad_campaigns', `business_id=eq.${business_id}&status=eq.active&select=*`),
      ]);
      const biz = bizArr[0];

      // Distribute budget: 40% awareness, 35% retargeting, 25% engagement
      const splits = { awareness: 0.4, retargeting: 0.35, engagement: 0.25 };
      const dailyCents = Math.round(budget * 100);

      for (const camp of campaigns) {
        const name = (camp.last_decision_reason || '').toLowerCase();
        const split = name.includes('aware')
          ? splits.awareness
          : name.includes('retarget')
            ? splits.retargeting
            : splits.engagement;
        const campBudget = Math.max(1, Math.round(budget * split));

        await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { daily_budget: campBudget });

        if (biz?.meta_access_token && camp.meta_campaign_id) {
          try {
            await externalHttp(
              apiRequest,
              'POST',
              `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}`,
              { 'Content-Type': 'application/json' },
              { daily_budget: campBudget * 100, access_token: biz.meta_access_token }
            );
          } catch (e) {
            log('/webhook/budget-updated', `Meta update warn: ${e.message}`);
          }
        }
      }

      if (biz?.email) {
        const html = `<h2>Budget Updated to $${budget}/day</h2>
<p>Your ad spend has been updated and distributed across your campaigns:</p>
<ul><li>Awareness: $${Math.round(budget * 0.4)}/day (40%)</li>
<li>Engagement: $${Math.round(budget * 0.25)}/day (25%)</li>
<li>Retargeting: $${Math.round(budget * 0.35)}/day (35%)</li></ul>`;
        await sendEmail(biz.email, `Budget updated to $${budget}/day`, html);
      }

      log('/webhook/budget-updated', `✅ Budget $${budget}/day distributed across ${campaigns.length} campaigns`);
    } catch (err) {
      console.error('[budget-updated ERROR]', err.message);
      await logError(business_id, 'budget-updated', err.message, req.body);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WF14: POST /webhook/competitor-check
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/competitor-check', async (req, res) => {
    const { business_id } = req.body;
    log('/webhook/competitor-check', `business_id=${business_id}`);

    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'Competitor analysis started' });

    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=*`))[0];
      if (!biz) throw new Error('Business not found');

      // Search for competitor data
      const competitors = biz.competitors || `${biz.industry} businesses in ${biz.city || 'local area'}`;
      const compNames = typeof competitors === 'string' ? competitors.split(',').slice(0, 3) : [competitors];

      let compData = '';
      for (const comp of compNames) {
        const r1 = await serpSearch(`${comp.trim()} social media marketing posts`, 3);
        const r2 = await serpSearch(`${comp.trim()} Instagram content`, 2);
        compData += `\n${comp.trim()}:\n` + [...r1, ...r2].map((r) => `- ${r.title}: ${r.snippet}`).join('\n');
      }

      const insights = await callClaude(
        `Analyze these competitors for ${biz.business_name} (${biz.industry} in ${biz.city || 'local'}):\n\n` +
          `${compData}\n\n` +
          `BUSINESS CONTEXT:\n` +
          `- Our differentiator: ${biz.unique_differentiator || 'Not set'}\n` +
          `- Our dream customer: ${biz.dream_customer || biz.target_audience || 'General'}\n` +
          `- Our goal: ${biz.primary_goal || biz.marketing_goal || 'Growth'}\n\n` +
          `Identify:\n` +
          `1. What each competitor is doing extremely well\n` +
          `2. The biggest gap or weakness we can exploit\n` +
          `3. 3 specific content ideas that position us as the better choice\n` +
          `4. One counter-campaign idea\n` +
          `5. The single most important action to take this week to beat competitors\n` +
          `Return ONLY valid JSON with keys: competitor_doing_well, gap_opportunity, content_to_steal (string of 3 ideas), positioning_tip, weekly_action`,
        'research',
        1500
      );

      if (insights && !insights._raw) {
        await sbPost('competitor_insights', {
          business_id,
          competitor_doing_well: insights.competitor_doing_well || '',
          gap_opportunity: insights.gap_opportunity || '',
          content_to_steal: insights.content_to_steal || '',
          positioning_tip: insights.positioning_tip || '',
        });
        try {
          storeInsight(
            business_id,
            'competitors',
            'competitive_intelligence',
            'competitor_weakness',
            insights.gap_opportunity || ''
          );
          storeInsight(
            business_id,
            'competitors',
            'competitive_intelligence',
            'our_advantage',
            insights.positioning_tip || ''
          );
        } catch {
          /* soft-fail */
        }
        log('/webhook/competitor-check', `✅ Insights saved for ${biz.business_name}`);
      }
    } catch (err) {
      console.error('[competitor-check ERROR]', err.message);
      await logError(business_id, 'competitor-check', err.message, req.body);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WF31: POST /webhook/generate-landing-page
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/generate-landing-page', async (req, res) => {
    const { business_id, campaign_id } = req.body;
    log('/webhook/generate-landing-page', `business_id=${business_id}`);

    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(String(business_id))) return res.status(400).json({ error: 'business_id must be a valid UUID' });
    if (campaign_id && !isUUID(String(campaign_id)))
      return res.status(400).json({ error: 'campaign_id must be a valid UUID' });

    try {
      const [bizArr, campArr] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=*`),
        campaign_id ? sbGet('ad_campaigns', `id=eq.${campaign_id}&select=*`) : Promise.resolve([]),
      ]);
      const biz = bizArr[0];
      const camp = campArr[0];
      if (!biz) return res.status(404).json({ error: 'Business not found' });

      const page = await callClaude(
        `Create a high-converting landing page for ${biz.business_name}.\n\n` +
          `OFFER: ${biz.unique_differentiator || biz.unique_selling_proposition || 'Premium local service'}\n` +
          `DREAM CUSTOMER: ${biz.dream_customer || biz.target_audience || 'Local consumers'}\n` +
          `PRIMARY GOAL: ${biz.primary_goal || biz.marketing_goal || 'Generate leads'}\n` +
          `BRAND VOICE: ${biz.brand_voice_locked || biz.brand_tone || 'Professional and warm'}\n` +
          `LOCATION: ${biz.city || ''} ${biz.state || ''}\n` +
          (camp ? `CAMPAIGN: ${camp.last_decision_reason || 'Ad campaign'}\n` : '') +
          `\nGenerate:\n` +
          `1. Powerful benefit-led headline\n` +
          `2. Compelling subheadline\n` +
          `3. 3 specific benefit bullets with social proof numbers (e.g. "97% satisfaction rate")\n` +
          `4. One testimonial that sounds real and specific with name and role\n` +
          `5. Urgency element (scarcity, deadline, or limited offer)\n` +
          `6. CTA button text\n` +
          `7. Form fields to collect (array of field names)\n` +
          `Return ONLY valid JSON with keys: hero_headline, hero_subheadline, hero_cta, value_prop_1, value_prop_2, value_prop_3, testimonial, testimonial_name, testimonial_role, urgency, form_fields`,
        'campaign',
        1500
      );

      // Build HTML
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${page.hero_headline || biz.business_name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;color:#333}
.hero{background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:80px 20px;text-align:center}
.hero h1{font-size:clamp(24px,5vw,48px);margin-bottom:16px;font-weight:800}
.hero p{font-size:clamp(16px,2.5vw,22px);opacity:.9;margin-bottom:32px;max-width:600px;margin-left:auto;margin-right:auto}
.cta-btn{background:white;color:#667eea;padding:16px 40px;border-radius:8px;font-size:18px;font-weight:700;text-decoration:none;display:inline-block}
.benefits{padding:60px 20px;max-width:900px;margin:0 auto}
.benefit{display:flex;gap:16px;margin-bottom:32px;align-items:flex-start}
.benefit-icon{font-size:32px;flex-shrink:0}
.testimonial{background:#f8f9ff;padding:40px 20px;text-align:center}
.testimonial blockquote{max-width:600px;margin:0 auto;font-size:20px;font-style:italic;color:#555;margin-bottom:16px}
.urgency{background:#fff8e7;border:2px solid #ffd166;padding:20px;text-align:center;font-size:18px;font-weight:600;color:#92400e}
.form-section{padding:60px 20px;max-width:500px;margin:0 auto;text-align:center}
.form-section h2{margin-bottom:30px;font-size:28px}
.form-section input{width:100%;padding:14px;margin-bottom:16px;border:2px solid #e8e8f0;border-radius:8px;font-size:16px}
.form-section button{width:100%;background:#667eea;color:white;padding:16px;border:none;border-radius:8px;font-size:18px;font-weight:700;cursor:pointer}
</style></head><body>
<div class="hero">
  <h1>${page.hero_headline || biz.business_name}</h1>
  <p>${page.hero_subheadline || ''}</p>
  <a href="#form" class="cta-btn">${page.hero_cta || 'Get Started'}</a>
</div>
<div class="urgency">${page.urgency || 'Limited spots available this month'}</div>
<div class="benefits">
  <div class="benefit"><div class="benefit-icon">✅</div><div><p>${page.value_prop_1 || ''}</p></div></div>
  <div class="benefit"><div class="benefit-icon">✅</div><div><p>${page.value_prop_2 || ''}</p></div></div>
  <div class="benefit"><div class="benefit-icon">✅</div><div><p>${page.value_prop_3 || ''}</p></div></div>
</div>
<div class="testimonial">
  <blockquote>"${page.testimonial || ''}"</blockquote>
  <p><strong>${page.testimonial_name || 'Happy Customer'}</strong>${page.testimonial_role ? ` — ${page.testimonial_role}` : ''}</p>
</div>
<div class="form-section" id="form">
  <h2>${page.hero_cta || 'Get Started Today'}</h2>
  ${(page.form_fields || ['Name', 'Email', 'Phone']).map((f) => `<input type="text" placeholder="${f}">`).join('\n  ')}
  <button type="submit">${page.hero_cta || 'Get Started'}</button>
</div>
</body></html>`;

      // Save to landing_pages table
      let savedId = null;
      try {
        const saved = await sbPost('landing_pages', {
          business_id,
          campaign_id: campaign_id || null,
          hero_headline: page.hero_headline || '',
          hero_subheadline: page.hero_subheadline || '',
          hero_cta: page.hero_cta || '',
          value_props: JSON.stringify([page.value_prop_1, page.value_prop_2, page.value_prop_3]),
          social_proof: page.testimonial || '',
          testimonials: JSON.stringify([
            { quote: page.testimonial, name: page.testimonial_name, role: page.testimonial_role },
          ]),
          closing_headline: page.urgency || '',
          closing_cta: page.hero_cta || '',
          html_content: html,
          status: 'draft',
        });
        savedId = saved?.id;
      } catch {
        /* soft-fail */
      }

      // Send email with HTML
      if (biz.email) {
        const emailHtml = `<h2>Your Landing Page is Ready!</h2>
<p>We've created a high-converting landing page for <strong>${biz.business_name}</strong>.</p>
<p><strong>Headline:</strong> ${page.hero_headline}</p>
<p><strong>CTA:</strong> ${page.hero_cta}</p>
<h3>Copy the HTML code below and paste it into your website:</h3>
<pre style="background:#f5f5f5;padding:20px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap">${html.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
        await sendEmail(biz.email, `Your landing page is ready, ${biz.first_name || biz.business_name}!`, emailHtml);
      }

      log('/webhook/generate-landing-page', `✅ Landing page saved row=${savedId}`);
      res.json({ success: true, row_id: savedId, hero_headline: page.hero_headline, html_length: html.length });
    } catch (err) {
      console.error('[generate-landing-page ERROR]', err.message);
      await logError(business_id, 'generate-landing-page', err.message, req.body);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Test email ───────────────────────────────────────────────────────────────
  app.post('/test-email', requireAdminSecret, async (req, res) => {
    const to = req.body?.email;
    const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
    const from = clean(process.env.FROM_EMAIL) || FROM_EMAIL;

    if (!to) return res.status(400).json({ error: 'email field required' });

    if (!apiKey)
      return res.status(500).json({
        error: 'RESEND_API_KEY is not set',
        fix: '1. Sign up free at resend.com  2. Get API key  3. Add RESEND_API_KEY to Railway env vars  4. Optionally add FROM_EMAIL (verified domain) — default is onboarding@resend.dev',
      });

    const result = await sendEmail(
      to,
      'maroa.ai — email test ✅',
      '<p>This is a test email from your Maroa.ai server. Email sending via Resend is working correctly!</p>'
    );

    if (result.sent) {
      res.json({ success: true, sent_to: to, from, resend_id: result.id });
    } else if (result.queued) {
      res.status(500).json({ error: 'RESEND_API_KEY missing', queued: true });
    } else {
      res.status(500).json({ error: result.error, from, hint: 'Check Railway logs for full error' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /meta-oauth-exchange
  // Called by Lovable's /social-callback page with the OAuth code.
  // Exchanges code → user token → page token, fetches Instagram ID,
  // saves everything to Supabase, then fires /webhook/account-connected.
  // Body: { code, business_id, redirect_uri? }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/meta-oauth-exchange', requireAnyUserId, async (req, res) => {
    const { code, business_id, redirect_uri } = req.body;
    if (!code || !business_id) return res.status(400).json({ error: 'code and business_id required' });

    const { assertBusinessOwner } = require('./lib/assertBusinessOwner');
    if (!(await assertBusinessOwner(req, res, business_id, { sbGet, apiError, logger }))) return;

    const APP_ID = clean(process.env.META_APP_ID) || '26551713411132003';
    const APP_SECRET = clean(process.env.META_APP_SECRET) || '';
    const REDIRECT = redirect_uri || 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

    // Guard: fail immediately if secret is missing — saves a confusing Facebook error
    if (!APP_SECRET) {
      log('/meta-oauth-exchange', 'META_APP_SECRET is not set in Railway env vars');
      return res.status(500).json({
        error: 'META_APP_SECRET is not configured on the server',
        fix: 'Go to Railway → your project → Variables → add META_APP_SECRET with your Meta app secret',
        redirect_uri: REDIRECT,
        app_id: APP_ID,
      });
    }

    log('/meta-oauth-exchange', `Starting exchange — app_id=${APP_ID} redirect_uri=${REDIRECT}`);

    try {
      // 1. Exchange code for user access token
      const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`;
      log('/meta-oauth-exchange', `Token exchange URL (no secret): client_id=${APP_ID}&redirect_uri=${REDIRECT}`);
      const tokenResp = await apiRequest('GET', tokenUrl);

      if (!tokenResp.body?.access_token) {
        const fbError = tokenResp.body?.error || tokenResp.body;
        log('/meta-oauth-exchange', `Token exchange failed: ${JSON.stringify(fbError)}`);
        return res.status(400).json({
          error: 'Token exchange failed',
          fb_error: fbError,
          redirect_uri: REDIRECT,
          app_id: APP_ID,
          hint: 'Make sure redirect_uri exactly matches what is registered in Meta App Dashboard → Facebook Login → Valid OAuth Redirect URIs',
        });
      }

      const userToken = tokenResp.body.access_token;
      log('/meta-oauth-exchange', `User token obtained for business_id=${business_id}`);

      // 2. Get long-lived user token (optional but better than short-lived)
      let longToken = userToken;
      try {
        const llResp = await apiRequest(
          'GET',
          `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${userToken}`
        );
        if (llResp.body?.access_token) longToken = llResp.body.access_token;
      } catch {
        /* soft-fail */
      }

      // 3. Get pages + page access token
      const pagesResp = await apiRequest(
        'GET',
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}&fields=id,name,access_token,fan_count`
      );
      const pages = pagesResp.body?.data || [];

      if (pages.length === 0) {
        log('/meta-oauth-exchange', `No pages found for business_id=${business_id}`);
        return res.status(400).json({ error: 'No Facebook pages found. Make sure you have a Business page.' });
      }

      const page = pages[0];
      const pageToken = page.access_token;
      const pageId = page.id;

      // 4. Get Instagram ID via debug_token granular_scopes (most reliable)
      let igId = null;
      const debugResp = await apiRequest(
        'GET',
        `https://graph.facebook.com/v19.0/debug_token?input_token=${pageToken}&access_token=${pageToken}`
      );
      const granular = debugResp.body?.data?.granular_scopes || [];
      const igScope = granular.find((s) => s.scope === 'instagram_basic');
      igId = igScope?.target_ids?.[0] || null;

      // Fallback: page fields
      if (!igId) {
        const igPageResp = await apiRequest(
          'GET',
          `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account,connected_instagram_account&access_token=${pageToken}`
        );
        igId =
          igPageResp.body?.instagram_business_account?.id || igPageResp.body?.connected_instagram_account?.id || null;
      }

      // 5. Save to Supabase
      const updates = {
        meta_access_token: pageToken,
        facebook_page_id: pageId,
        social_accounts_connected: true,
      };
      if (page.fan_count) updates.followers_gained = page.fan_count;
      if (igId) updates.instagram_account_id = igId;

      await sbPatch('businesses', `id=eq.${business_id}`, updates);

      // 6. Fire account-connected logic (campaigns + email)
      setImmediate(async () => {
        try {
          await apiRequest(
            'POST',
            `http://localhost:${PORT}/webhook/account-connected`,
            { 'Content-Type': 'application/json' },
            { business_id, meta_access_token: pageToken, facebook_page_id: pageId }
          );
        } catch {
          /* soft-fail */
        }
      });

      log('/meta-oauth-exchange', `✅ Saved page=${pageId} ig=${igId || 'none'} for business_id=${business_id}`);

      res.json({
        success: true,
        facebook_page_id: pageId,
        facebook_page_name: page.name,
        instagram_id: igId || null,
        message: `Connected: Facebook (${page.name})${igId ? ' + Instagram' : ''}`,
      });
    } catch (err) {
      console.error('[meta-oauth-exchange ERROR]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // BUILD 1 — BILLING + PLAN GATES
  // Plans: starter($25) · growth($59) · agency($99)
  // ═════════════════════════════════════════════════════════════════════════════

  const { buildPlansCatalog } = require('./lib/planCatalog');
  const PLANS = buildPlansCatalog({
    starterPriceId: PADDLE_STARTER_PRICE,
    growthPriceId: PADDLE_GROWTH_PRICE,
    agencyPriceId: PADDLE_AGENCY_PRICE,
  });

  // GET /api/billing/plans — public, no auth needed
  app.get('/api/billing/plans', (req, res) => {
    res.json({ plans: PLANS });
  });

  // ─── Inngest serve handler ────────────────────────────────────────────────
  // Mounts our Inngest cron + event functions (services/inngest/functions.js)
  // at /api/inngest. This is the URL Inngest Cloud calls to invoke functions.
  // Set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in Railway env to activate.
  // Without those env vars, the handler still loads but returns 401 to Inngest
  // Cloud — safe to ship before keys are set.
  try {
    const { serve: inngestServe } = require('inngest/express');
    const { inngest } = require('./services/inngest/client');
    const { functions: inngestFunctions } = require('./services/inngest/functions');
    app.use(
      '/api/inngest',
      inngestServe({
        client: inngest,
        functions: inngestFunctions,
        // serveHost lets Inngest Cloud know the public URL when behind a proxy.
        serveHost: process.env.INNGEST_SERVE_HOST || undefined,
      })
    );
    console.log(`[inngest] mounted ${inngestFunctions.length} functions at /api/inngest`);
  } catch (e) {
    console.error('[inngest] failed to mount:', e.message);
  }

  // ─── Brand Voice (read + rebuild) ─────────────────────────────────────────
  // Frontend BrandVoiceCard reads from this. Returns null body when no anchor exists yet.
  const brandVoiceService = require('./services/prompts/brand-voice');

  function _toUiBrandVoice(anchor, vocLatest) {
    if (!anchor) return null;
    const tone =
      Array.isArray(anchor.tone_descriptors) && anchor.tone_descriptors.length
        ? anchor.tone_descriptors.join(', ')
        : anchor.voice_register || '';
    const customerPhrases = [];
    if (vocLatest) {
      for (const key of ['jtbd_signals', 'pain_points']) {
        const arr = Array.isArray(vocLatest[key]) ? vocLatest[key] : [];
        for (const item of arr) {
          const phrase = typeof item === 'string' ? item : (item && (item.phrase || item.quote || item.text)) || null;
          if (phrase && customerPhrases.length < 8) customerPhrases.push(phrase);
        }
      }
    }
    const confidenceMap = { high: 92, medium: 70, low: 45, minimal: 25 };
    return {
      tone,
      do_use: Array.isArray(anchor.do_words) ? anchor.do_words : [],
      do_not_use: Array.isArray(anchor.do_not_words) ? anchor.do_not_words : [],
      customer_phrases: customerPhrases,
      updated_at: anchor.regenerated_at || null,
      confidence: confidenceMap[String(anchor.confidence || '').toLowerCase()] || null,
      derived_from: Array.isArray(anchor.derived_from) ? anchor.derived_from.join(' · ') : null,
    };
  }

  // POST /api/content/generate — synchronous instant content generation.
  // Unlike /webhook/instant-content which is fire-and-forget, this awaits the
  // full generateInstantContent flow and returns the row (or a real error).
  // Frontend UX path: WelcomeModal + Generate Now buttons hit this for honest
  // success/failure feedback.
  app.post('/api/content/generate', async (req, res) => {
    const businessId = String((req.body && (req.body.business_id || req.body.businessId)) || '').trim();
    const userId = String((req.body && (req.body.user_id || req.body.userId)) || '').trim();
    const email = String((req.body && req.body.email) || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'business_id required');

    try {
      const rl = await checkRateLimit(`gen:${businessId || userId || req.ip}`);
      if (!rl.success)
        return apiError(res, 429, 'RATE_LIMITED', 'Too many generation requests — please wait 1 minute.');
    } catch {
      /* soft-fail */
    }

    try {
      const bizRows = await sbGet(
        'businesses',
        `id=eq.${encodeURIComponent(businessId)}&select=id,business_name,industry,brand_tone,plan`
      );
      if (!bizRows[0]) {
        return apiError(
          res,
          404,
          'BUSINESS_NOT_FOUND',
          `No business profile found for id ${businessId}. Finish onboarding first.`
        );
      }
      const biz = bizRows[0];
      const result = await generateInstantContent(businessId, email || undefined);

      // P0-3 compliance gate — screen the generated copy before we hand it
      // back to the customer. Hard violations return 422 with the verdict;
      // the dashboard can offer the rewrite (verdict.rewrite) or an appeal.
      try {
        const draftBlob = [
          result.instagram_caption,
          result.facebook_post,
          result.linkedin_post,
          result.email_subject,
          result.email_body,
          result.blog_title,
        ]
          .filter(Boolean)
          .join('\n---\n');
        if (draftBlob) {
          const verdict = await _ensureCompliant({
            content: draftBlob,
            industry: biz.industry,
            businessId,
            plan: biz.plan,
            surface: 'social_post',
            deps: { callClaude, sbPost, logger },
          });
          if (verdict.severity === 'soft' && verdict.violations.length) {
            result.compliance_warnings = verdict.violations;
          }
        }
      } catch (cgErr) {
        if (cgErr instanceof _ComplianceBlocked) {
          return apiError(res, 422, 'COMPLIANCE_HARD_BLOCK', 'Draft contains disallowed claims', {
            violations: cgErr.violations,
            rewrite: cgErr.rewrite,
            appealable: cgErr.appealable,
          });
        }
        throw cgErr;
      }

      res.json({ ok: true, content: result });
      if (email) {
        try {
          const html = `<h2>Your weekly content is ready!</h2><p>Theme: <strong>${result.content_theme || 'Weekly Content'}</strong></p><p><a href="https://maroa.ai/dashboard?tab=content">Review &amp; Approve Content</a></p>`;
          await sendEmail(email, `Your ${result.content_theme || 'weekly'} content is ready!`, html);
        } catch {
          /* soft-fail */
        }
      }
    } catch (err) {
      console.error('[/api/content/generate]', err.message);
      try {
        await logError(businessId, 'instant-content-sync', err.message, req.body);
      } catch {
        /* soft-fail */
      }
      return apiError(res, 500, 'GENERATION_FAILED', err.message || 'Content generation failed');
    }
  });

  // GET /api/cron-health/:businessId — drives the live "Lead scoring active",
  // "Competitor monitoring", "SEO monitoring" status banners on Home.
  // Reads last-run timestamps from the existing tables that each cron writes to.
  // A cron is "healthy" if it ran inside its expected cadence + a 30% grace window.
  app.get('/api/cron-health/:businessId', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    // Rule 4: encode all PostgREST filter inputs (M1 hardening).
    const safeBiz = encodeURIComponent(businessId);

    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    const now = Date.now();

    function statusFor(lastRunIso, expectedIntervalMs) {
      if (!lastRunIso) return { last_run_at: null, healthy: false, age_hours: null };
      const ts = new Date(lastRunIso).getTime();
      if (Number.isNaN(ts)) return { last_run_at: lastRunIso, healthy: false, age_hours: null };
      const ageMs = now - ts;
      const grace = expectedIntervalMs * 1.3;
      return {
        last_run_at: lastRunIso,
        healthy: ageMs <= grace,
        age_hours: Math.round(ageMs / HOUR),
      };
    }

    try {
      const [contentRows, compRows, snapRows, learnRows, retentionRows, winRows] = await Promise.all([
        sbGet('generated_content', `business_id=eq.${safeBiz}&select=created_at&order=created_at.desc&limit=1`).catch(
          () => []
        ),
        sbGet(
          'competitor_insights',
          `business_id=eq.${safeBiz}&select=recorded_at&order=recorded_at.desc&limit=1`
        ).catch(() => []),
        sbGet(
          'analytics_snapshots',
          `business_id=eq.${safeBiz}&select=snapshot_date&order=snapshot_date.desc&limit=1`
        ).catch(() => []),
        sbGet('learning_logs', `business_id=eq.${safeBiz}&select=created_at&order=created_at.desc&limit=1`).catch(
          () => []
        ),
        sbGet('retention_logs', `business_id=eq.${safeBiz}&select=sent_at&order=sent_at.desc&limit=1`).catch(() => []),
        sbGet('win_notifications', `business_id=eq.${safeBiz}&select=notified_at&order=notified_at.desc&limit=1`).catch(
          () => []
        ),
      ]);

      return res.json({
        generated_at: new Date().toISOString(),
        content_generation: statusFor(contentRows[0]?.created_at, 7 * DAY), // weekly cron
        competitor_monitor: statusFor(compRows[0]?.recorded_at, 7 * DAY), // weekly Friday scan
        analytics_snapshot: statusFor(snapRows[0]?.snapshot_date, 1 * DAY), // daily
        lead_scoring: statusFor(learnRows[0]?.created_at, 1 * DAY), // daily
        retention_emails: statusFor(retentionRows[0]?.sent_at, 1 * DAY),
        win_notifications: statusFor(winRows[0]?.notified_at, 6 * HOUR),
      });
    } catch (err) {
      console.error('[cron-health]', err.message);
      return apiError(res, 500, 'CRON_HEALTH_FAILED', err.message);
    }
  });

  const { createIntegrationsService } = require('./services/integrations');
  const integrationsService = createIntegrationsService({ sbGet, apiRequest, logger });

  // GET /api/business/:businessId/integrations — v2 health (live Meta probe when configured)
  app.get('/api/business/:businessId/integrations', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    try {
      const health = await integrationsService.getHealth(businessId, {
        probeLive: req.query.probe !== '0',
      });
      if (!health.ok) return apiError(res, 404, 'NOT_FOUND', health.reason || 'Business not found');
      return res.json(health);
    } catch (err) {
      return apiError(res, 500, 'INTEGRATIONS_FAILED', err.message);
    }
  });

  // POST /api/business/:businessId/brand-assets — set the customer's logo +
  // product/shop reference photos (migration 088). Accepts already-hosted
  // URLs (the frontend uploads the file to storage, then sends the URL here).
  // These are consumed by WF1: product images become the Higgsfield reference
  // image, the logo a brand cue. JWT + business-owner gated by the /api/business
  // app.use prefixes above.
  app.post('/api/business/:businessId/brand-assets', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    const body = req.body || {};
    const patch = {};

    if (body.logo_url !== undefined) {
      const logo = body.logo_url === null ? null : String(body.logo_url).trim();
      if (logo && !/^https?:\/\//i.test(logo)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'logo_url must be an http(s) URL');
      }
      patch.logo_url = logo || null;
    }

    if (body.product_image_urls !== undefined) {
      const raw = Array.isArray(body.product_image_urls) ? body.product_image_urls : [];
      const urls = raw
        .map((u) => String(u || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, 20); // cap — matches Higgsfield reference ceiling
      if (raw.length && !urls.length) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_urls must be http(s) URLs');
      }
      patch.product_image_urls = urls;
    }

    if (!Object.keys(patch).length) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'provide logo_url and/or product_image_urls');
    }

    try {
      await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, patch);
      return res.json({ ok: true, business_id: businessId, updated: Object.keys(patch) });
    } catch (e) {
      return apiError(res, 500, 'BRAND_ASSETS_UPDATE_FAILED', e.message);
    }
  });

  // GET /api/business/:businessId/llm-spend — monthly LLM cost vs plan cap
  app.get('/api/business/:businessId/llm-spend', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    try {
      const { checkCostCap } = require('./lib/costGuard');
      const { checkWebSearchBudget } = require('./lib/webSearchGate');
      const [cap, web] = await Promise.all([
        checkCostCap({ businessId, sbGet }),
        checkWebSearchBudget({
          businessId,
          sbGet,
          plan: (await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=plan`).catch(() => []))[0]
            ?.plan,
        }),
      ]);
      return res.json({
        business_id: businessId,
        month: new Date().toISOString().slice(0, 7),
        used_usd: cap.used_usd,
        cap_usd: cap.cap_usd,
        plan: cap.plan,
        allowed: cap.allowed,
        percent_used: cap.cap_usd > 0 ? Math.round((cap.used_usd / cap.cap_usd) * 1000) / 10 : 0,
        web_search: {
          used: web.used ?? 0,
          cap: web.cap ?? 0,
          allowed: !!web.allowed,
          remaining: web.remaining ?? 0,
        },
        anthropic_features: {
          advisor_tool: process.env.MAROA_ADVISOR_ENABLED !== 'false',
          web_search: (web.cap ?? 0) > 0,
          managed_agents_deep_dive: String(cap.plan || '').toLowerCase() === 'agency',
        },
      });
    } catch (err) {
      return apiError(res, 500, 'LLM_SPEND_FAILED', err.message);
    }
  });

  // GET /api/ops/platform — operator snapshot (auth: same as /api/business)
  app.get('/api/ops/platform', async (req, res) => {
    try {
      const { probeCriticalMigrations, getPlatformSnapshot } = require('./lib/platformOps');
      let inngestCount = null;
      try {
        const { functions } = require('./services/inngest/functions');
        inngestCount = functions.length;
      } catch {
        /* soft */
      }
      const migrations = await probeCriticalMigrations(sbGet);
      return res.json({
        ...getPlatformSnapshot({ inngestFunctionCount: inngestCount }),
        migrations,
      });
    } catch (err) {
      return apiError(res, 500, 'OPS_PLATFORM_FAILED', err.message);
    }
  });

  app.get('/api/business/:businessId/brand-voice', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return res.status(400).json({ error: 'businessId required' });
    try {
      const profileRows = await sbGet(
        'business_profiles',
        `user_id=eq.${businessId}&select=brand_voice_anchor,brand_voice_regenerated_at`
      ).catch(() => []);
      const profile = profileRows[0] || {};
      let anchor = profile.brand_voice_anchor || null;
      if (typeof anchor === 'string') {
        try {
          anchor = JSON.parse(anchor);
        } catch {
          anchor = null;
        }
      }
      if (!anchor) {
        const bizRows = await sbGet('businesses', `id=eq.${businessId}&select=brand_voice_locked,brand_tone`).catch(
          () => []
        );
        const biz = bizRows[0] || {};
        let locked = biz.brand_voice_locked || null;
        if (typeof locked === 'string') {
          try {
            locked = JSON.parse(locked);
          } catch {
            locked = null;
          }
        }
        if (locked && typeof locked === 'object') anchor = locked;
      }
      if (!anchor && req.query.fallback !== 'false') {
        return res.json({ voice: null });
      }
      let voc = null;
      try {
        const vocRows = await sbGet('voc_analyses', `business_id=eq.${businessId}&order=analyzed_at.desc&limit=1`);
        voc = vocRows[0] || null;
      } catch {
        voc = null;
      }
      const ui = _toUiBrandVoice(anchor, voc);
      return res.json({ voice: ui });
    } catch (err) {
      console.error('[brand-voice GET]', err.message);
      res.status(500).json({ error: 'brand-voice fetch failed', detail: err.message });
    }
  });

  app.post('/webhook/build-brand-voice', async (req, res) => {
    const businessId = String((req.body && (req.body.business_id || req.body.businessId)) || '').trim();
    if (!businessId) return res.status(400).json({ error: 'business_id required' });
    try {
      const [bizRows, profileRows, vocRows] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
        sbGet('voc_analyses', `business_id=eq.${businessId}&order=analyzed_at.desc&limit=1`).catch(() => []),
      ]);
      const biz = { ...(bizRows[0] || {}), ...(profileRows[0] || {}) };
      if (!biz || (!biz.id && !bizRows[0])) return res.status(404).json({ error: 'business not found' });
      const anchor = brandVoiceService.buildAnchor({ business: biz, vocAnalysis: vocRows[0] || null });
      if (profileRows[0]) {
        await sbPatch('business_profiles', `user_id=eq.${businessId}`, {
          brand_voice_anchor: anchor,
          brand_voice_regenerated_at: new Date().toISOString(),
        }).catch(() => {});
      }
      await sbPatch('businesses', `id=eq.${businessId}`, {
        brand_voice_locked: JSON.stringify(anchor),
      }).catch(() => {});
      const ui = _toUiBrandVoice(anchor, vocRows[0] || null);
      return res.json({ ok: true, voice: ui });
    } catch (err) {
      console.error('[build-brand-voice]', err.message);
      res.status(500).json({ error: 'build-brand-voice failed', detail: err.message });
    }
  });

  // POST /api/checkout — create Paddle checkout session
  // Body: { user_id, plan }
  app.post('/api/checkout', async (req, res) => {
    const { user_id, plan, success_url } = req.body;
    if (!user_id || !plan) return res.status(400).json({ error: 'user_id and plan required' });

    if (!paddle.PADDLE_API_KEY) return res.status(500).json({ error: 'PADDLE_API_KEY not set in Railway env vars' });

    const planObj = PLANS[plan];
    if (!planObj) return res.status(400).json({ error: `Unknown plan: ${plan}. Valid: starter, growth, agency` });
    if (!planObj.priceId)
      return res
        .status(400)
        .json({ error: `No Paddle price ID for "${plan}". Set PADDLE_${plan.toUpperCase()}_PRICE_ID in Railway.` });

    let biz;
    try {
      biz = (await sbGet('businesses', `id=eq.${user_id}&select=email,first_name,business_name`))[0];
    } catch (err) {
      return res.status(500).json({ error: 'Database error', detail: err.message });
    }
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    try {
      const result = await paddle.createCheckoutSession({
        priceId: planObj.priceId,
        businessId: user_id,
        plan,
        customerEmail: biz.email,
        successUrl: success_url || 'https://maroa.ai/dashboard?upgraded=true',
      });
      log('/api/checkout', `Paddle checkout for ${biz.email} → ${plan}`);
      res.json({ success: true, checkout_url: result.checkout_url, transaction_id: result.transaction_id });
    } catch (err) {
      console.error('[checkout ERROR]', err.message);
      res.status(500).json({ error: 'Paddle checkout failed', detail: err.message });
    }
  });

  // Keep legacy route as alias
  app.post('/webhook/create-checkout', async (req, res) => {
    req.body.user_id = req.body.user_id || req.body.business_id;
    return app._router.handle(
      Object.assign(req, { url: '/api/checkout', originalUrl: '/api/checkout' }),
      res,
      () => {}
    );
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // BUILD 2 — AGENCY MULTI-WORKSPACE (carved into routes/org-management.js)
  // 5 endpoints — org-create, org-get, org-add-workspace, org-invite-member,
  // org-white-label-update. All planGate'd. Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/org-management').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    sendEmail,
    planGate,
    log,
    logError,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // BUILD 3 — LINKEDIN AUTOPILOT (carved into routes/linkedin-publishing.js)
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/linkedin-publishing').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    sbDelete,
    callClaude,
    log,
    logError,
    getBrandExamples,
    env,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // BUILD 4 — X (TWITTER) AUTOPILOT (carved into routes/twitter-publishing.js)
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/twitter-publishing').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    sbDelete,
    callClaude,
    log,
    logError,
    getBrandExamples,
    env,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // BUILD 5 — TIKTOK AUTOPILOT (carved into routes/tiktok-publishing.js)
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/tiktok-publishing').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    sbDelete,
    callClaude,
    log,
    logError,
    getBrandExamples,
    env,
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // SPRINT 2.1 — Unified Analytics Dashboard
  // SPRINT 2.2 — Behavior-Triggered Email Flows
  // ═══════════════════════════════════════════════════════════════════════════════

  // ── Supabase upsert (merge-duplicates on conflict) ────────────────────────────
  async function sbUpsert(table, data, onConflict) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
    const r = await apiRequest(
      'POST',
      url,
      { ...sbH(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
      data
    );
    if (![200, 201].includes(r.status))
      throw new Error(`sbUpsert ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    return Array.isArray(r.body) ? r.body[0] : r.body;
  }

  // ── sendEmailWithTags: Resend + tag support for webhook attribution ────────────
  async function sendEmailWithTags(to, subject, html, tags = []) {
    const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
    const from = clean(process.env.FROM_EMAIL) || FROM_EMAIL;
    if (!apiKey || !to) {
      console.log('[REDACTED]');
      return { queued: true };
    }
    try {
      const payload = { from: `maroa.ai <${from}>`, to: [to], reply_to: 'hello@maroa.ai', subject, html };
      if (tags.length) payload.tags = tags;
      const r = await apiRequest(
        'POST',
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        payload
      );
      if ([200, 201].includes(r.status)) {
        console.log('[REDACTED]');
        return { sent: true, id: r.body?.id };
      }
      return { error: r.body?.message, status: r.status };
    } catch (e) {
      return { error: e.message };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ANALYTICS — carved into routes/analytics.js
  // 3 endpoints — analytics-snapshot, analytics-report, analytics-get.
  // Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  const analyticsRoutes = require('./routes/analytics');
  analyticsRoutes.register({
    app,
    sbGet,
    sbPost,
    sbUpsert,
    callClaude,
    apiRequest,
    sendEmail,
    log,
    logError,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // EMAIL LIFECYCLE — carved into routes/email-lifecycle.js
  // 4 endpoints — email-sequence-create, email-enroll, email-trigger
  // (Resend webhook), email-sequence-process (cron tick).
  // Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/email-lifecycle').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    sendEmailWithTags,
    log,
    logError,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/no-open-candidates?days=7
  // Returns businesses with old retention_log entries whose email is NOT
  // already actively enrolled. Used by WF37.
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/no-open-candidates', async (req, res) => {
    const days = parseInt(req.query.days || '7', 10);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    try {
      // Step 1: get all business_ids with retention logs older than cutoff
      const oldLogs = await sbGet('retention_logs', `sent_at=lt.${cutoff}&select=business_id`);
      const bizIds = [...new Set(oldLogs.map((r) => r.business_id).filter(Boolean))];
      if (!bizIds.length) return res.json({ candidates: [], count: 0 });

      // Step 2: fetch those businesses
      const businesses = await sbGet(
        'businesses',
        `id=in.(${bizIds.join(',')})&is_active=eq.true&select=id,email,first_name,business_name`
      );
      const emails = businesses.map((b) => b.email).filter(Boolean);
      if (!emails.length) return res.json({ candidates: [], count: 0 });

      // Step 3: find which emails are already actively enrolled
      const active = await sbGet(
        'contact_enrollments',
        `contact_email=in.(${emails.map((e) => encodeURIComponent(e)).join(',')})&status=eq.active&select=contact_email`
      );
      const enrolledSet = new Set(active.map((e) => e.contact_email));

      // Step 4: return those NOT enrolled
      const candidates = businesses
        .filter((b) => b.email && !enrolledSet.has(b.email))
        .map((b) => ({
          business_id: b.id,
          contact_email: b.email,
          contact_name: b.first_name || b.business_name,
        }));

      res.json({ candidates, count: candidates.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // SPRINT 3 — Paid Ads Module (Meta + Google)
  // ═══════════════════════════════════════════════════════════════════════════════

  const GOOGLE_ADS_DEV_TOKEN = clean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN) || '';
  const GOOGLE_ADS_CLIENT_ID = clean(process.env.GOOGLE_ADS_CLIENT_ID) || '';
  const GOOGLE_ADS_CLIENT_SECRET = clean(process.env.GOOGLE_ADS_CLIENT_SECRET) || '';

  // ═════════════════════════════════════════════════════════════════════════════
  // GOOGLE CAMPAIGNS — carved into routes/google-campaigns.js
  // 4 endpoints — google-campaign-create, google-campaign-activate (plan-gated),
  // google-campaign-optimize, google-campaigns-get.
  // Internal helpers gCid + googleAdsReq moved into the module.
  // Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/google-campaigns').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    apiRequest,
    sendEmail,
    planGate,
    log,
    logError,
    GOOGLE_ADS_DEV_TOKEN,
    sbUpsert,
  });

  function actId(adAccountId) {
    if (!adAccountId) return null;
    const s = String(adAccountId).trim();
    return s.startsWith('act_') ? s : `act_${s}`;
  }

  require('./routes/meta-campaigns').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    apiRequest,
    generateImage,
    saveImageToSupabase,
    sendEmail,
    planGate,
    actId,
    log,
    logError,
    storeInsight,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // CRM (contacts + deals + pipeline) — carved into routes/crm.js
  // 8 endpoints + SCORE_WEIGHTS constant. Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/crm').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    sendEmail,
    isUUID,
    log,
    apiRequest,
    sbH,
    SUPABASE_URL,
    storeInsight,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // COMPETITOR INTEL — carved into routes/competitor-intel.js
  // 2 endpoints — competitor-analyze, competitor-report-get.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/competitor-intel').register({
    app,
    sbGet,
    sbPost,
    callClaude,
    apiRequest,
    sendEmail,
    log,
    logError,
    SERPAPI_KEY,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // CONTENT WORKFLOW — carved into routes/content-workflow.js
  // 3 endpoints — content-generate, content-pieces-get, content-approve.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/content-workflow').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    apiRequest,
    sendEmail,
    log,
    logError,
    SERPAPI_KEY,
    generateSmartImage,
    isUUID,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRINT 6 — SEO AUTOPILOT + CRO ENGINE + VIDEO GENERATION
  // ─────────────────────────────────────────────────────────────────────────────

  // ── HTML parser helpers (shared between seo-audit + future routes) ──

  // ═════════════════════════════════════════════════════════════════════════════
  // SEO + CRO — carved into routes/seo-cro.js
  // 5 endpoints — seo-audit, seo-recommendations-get, seo-recommendation-apply,
  // cro-analyze, cro-generate-copy. HTML helpers moved into the module.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/seo-cro').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    apiRequest,
    log,
    logError,
    storeInsight,
    SERPAPI_KEY,
    serpSearch,
    isUUID,
    getBrandExamples,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // VIDEO GENERATION — carved into routes/video-generation.js
  // 4 endpoints — video-script-generate, video-generate-runway,
  // video-status, videos-get. Behavior unchanged.
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/video-generation').register({
    app,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    apiRequest,
    sendEmail,
    log,
    logError,
    generateImage,
    saveImageToSupabase,
    RUNWAY_API_KEY,
    getBrandExamples,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRINT 5 — BRAND MEMORY + WHITE-LABEL + REVIEWS
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/brand-memory-store
  // Store a high-performing content piece as a vector in Pinecone.
  // Body: { business_id, content_type, text, performance_score }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/brand-memory-store', async (req, res) => {
    const { business_id, content_type, text, performance_score = 0 } = req.body;
    if (!business_id || !text) return res.status(400).json({ error: 'business_id and text required' });
    const validTypes = ['social_post', 'email', 'ad_copy', 'blog', 'video_script', 'competitor_intelligence'];
    if (!validTypes.includes(content_type))
      return res.status(400).json({ error: `content_type must be one of: ${validTypes.join('|')}` });

    if (performance_score < 7)
      return res.json({ stored: false, reason: 'performance_score below threshold (7)', performance_score });

    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST)
      return res.json({
        stored: false,
        reason: 'Brand memory not configured — set OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST',
      });

    try {
      let vector;
      try {
        vector = await getEmbedding(text);
      } catch (embedErr) {
        return res.json({ stored: false, reason: `Embedding failed: ${embedErr.message.slice(0, 100)}` });
      }
      const vector_id = `${business_id}-${Date.now()}`;
      await pineconeUpsert([
        {
          id: vector_id,
          values: vector,
          metadata: {
            businessId: business_id,
            contentType: content_type,
            performance_score,
            text: text.slice(0, 500),
          },
        },
      ]);
      res.json({ stored: true, vector_id, content_type, performance_score });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/brand-memory-retrieve
  // Retrieve semantically similar best-performing content from Pinecone.
  // Body: { business_id, content_type, topic }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/brand-memory-retrieve', async (req, res) => {
    const { business_id, content_type = 'social_post', topic } = req.body;
    if (!business_id || !topic) return res.status(400).json({ error: 'business_id and topic required' });

    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST)
      return res.json({ examples: [], reason: 'Brand memory not configured' });

    try {
      let vector;
      try {
        vector = await getEmbedding(topic);
      } catch (embedErr) {
        return res.json({ examples: [], count: 0, reason: `Embedding failed: ${embedErr.message.slice(0, 100)}` });
      }
      const result = await pineconeQuery(
        vector,
        { businessId: { $eq: business_id }, contentType: { $eq: content_type } },
        3
      );
      const matches = (result.matches || []).filter((m) => m.score > 0.6 && m.metadata?.text);
      const examples = matches.map((m) => m.metadata.text);
      res.json({ examples, count: examples.length, content_type, topic });
    } catch (err) {
      res.status(500).json({ examples: [], count: 0, error: safePublicError(err) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/brand-memory-train
  // Train brand memory on last 7 days of published content for a business.
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/brand-memory-train', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST)
      return res.json({
        trained_on: 0,
        stored: 0,
        reason: 'Brand memory not configured — set OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST',
      });

    try {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const pieces = await sbGet(
        'generated_content',
        `business_id=eq.${business_id}&status=eq.published&published_at=gte.${since}&select=id,instagram_caption,facebook_post,email_body,blog_title,content_theme,performance_score,image_url`
      );

      if (!pieces.length) return res.json({ trained_on: 0, stored: 0, reason: 'No published content in last 30 days' });

      let stored = 0;
      const results = [];

      for (const p of pieces) {
        // Use real performance_score from DB, clamped to 0-10
        const score = Math.min(10, Math.max(0, Number(p.performance_score) || 0));

        // Only store content scoring 7+ (quality threshold)
        if (score < 7) {
          results.push({ theme: p.content_theme, score, stored: false, reason: 'below_threshold' });
          continue;
        }

        const candidates = [
          { type: 'social_post', text: p.instagram_caption || p.facebook_post },
          { type: 'email', text: p.email_body },
          { type: 'blog', text: p.blog_title },
        ].filter((c) => c.text && c.text.length > 20);

        for (const c of candidates) {
          try {
            // Call Pinecone directly — not via HTTP localhost
            const vector = await getEmbedding(c.text);
            const vectorId = `${business_id}-${p.id}-${c.type}`;
            await pineconeUpsert([
              {
                id: vectorId,
                values: vector,
                metadata: {
                  businessId: business_id,
                  contentType: c.type,
                  performance_score: score,
                  text: c.text.slice(0, 500),
                  theme: p.content_theme || '',
                },
              },
            ]);
            stored++;
            results.push({ type: c.type, score, stored: true });
          } catch (e) {
            results.push({ type: c.type, score, stored: false, error: e.message });
          }
        }
      }

      res.json({ trained_on: pieces.length, stored, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/white-label-update   [agency plan only]
  // Body: { business_id, organization_id, company_name, primary_color, logo_url, domain, support_email }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/white-label-update', planGate('white_label'), async (req, res) => {
    const { organization_id, company_name, primary_color, logo_url, domain, support_email } = req.body;
    if (!organization_id) return res.status(400).json({ error: 'organization_id required' });
    if (!isUUID(String(organization_id)))
      return res.status(400).json({ error: 'organization_id must be a valid UUID' });

    // Ownership: a JWT caller must own or admin this organization. Internal
    // webhook-secret callers (authSource==='webhook') are trusted. Without
    // this, any agency-plan user could rewrite another org's white-label.
    if (req.authSource !== 'webhook') {
      const uid = req.user?.id;
      const owns =
        uid &&
        isUUID(String(uid)) &&
        ((
          await sbGet(
            'organizations',
            `id=eq.${encodeURIComponent(organization_id)}&owner_user_id=eq.${encodeURIComponent(uid)}&select=id&limit=1`
          ).catch(() => [])
        ).length ||
          (
            await sbGet(
              'organization_members',
              `organization_id=eq.${encodeURIComponent(organization_id)}&user_id=eq.${encodeURIComponent(uid)}&role=in.(owner,admin)&select=id&limit=1`
            ).catch(() => [])
          ).length);
      if (!owns) return apiError(res, 403, 'FORBIDDEN', 'You do not have access to this organization');
    }

    try {
      const updates = {};
      if (company_name) updates.white_label_company_name = company_name;
      if (primary_color) updates.white_label_primary_color = primary_color;
      if (logo_url) updates.white_label_logo_url = logo_url;
      if (domain) updates.white_label_domain = domain;
      if (support_email) updates.white_label_support_email = support_email;

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No white-label fields provided' });

      await sbPatch('organizations', `id=eq.${organization_id}`, updates);

      const orgs = await sbGet('organizations', `id=eq.${organization_id}&select=*`);
      const settings = orgs[0] || {};
      res.json({
        updated: true,
        settings: {
          company_name: settings.white_label_company_name,
          primary_color: settings.white_label_primary_color,
          logo_url: settings.white_label_logo_url,
          domain: settings.white_label_domain,
          support_email: settings.white_label_support_email,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/white-label-get?organization_id=X
  // Used by Lovable frontend to inject custom branding on load.
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/white-label-get', async (req, res) => {
    const { organization_id } = req.query;
    if (!organization_id) return res.status(400).json({ error: 'organization_id required' });
    if (!isUUID(String(organization_id)))
      return res.status(400).json({ error: 'organization_id must be a valid UUID' });
    try {
      const orgs = await sbGet(
        'organizations',
        `id=eq.${encodeURIComponent(organization_id)}&select=white_label_company_name,white_label_primary_color,white_label_logo_url,white_label_domain,white_label_support_email,name`
      );
      const o = orgs[0];
      if (!o) return res.status(404).json({ error: 'organization not found' });
      res.json({
        company_name: o.white_label_company_name || o.name,
        primary_color: o.white_label_primary_color || '#667eea',
        logo_url: o.white_label_logo_url || null,
        domain: o.white_label_domain || null,
        support_email: o.white_label_support_email || 'hello@maroa.ai',
        is_white_labeled: !!(o.white_label_company_name || o.white_label_domain),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/review-request-send
  // Generate personalised review-request email via Claude and send via Resend.
  // Body: { business_id, contact_email, contact_name, platform }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/review-request-send', async (req, res) => {
    const { business_id, contact_email, contact_name, platform = 'google' } = req.body;
    if (!business_id || !contact_email)
      return res.status(400).json({ error: 'business_id and contact_email required' });

    try {
      const bizArr = await sbGet(
        'businesses',
        `id=eq.${business_id}&select=business_name,first_name,email,google_review_link`
      );
      const biz = bizArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });

      const reviewLink = biz.google_review_link || 'https://g.page/r/review';

      const prompt = `Write a friendly short email (under 80 words) asking ${contact_name || 'a valued customer'} to leave a Google review for ${biz.business_name}.
Owner name: ${biz.first_name || biz.business_name}. Review link: ${reviewLink}.
Be warm and genuine. Not pushy. Address them by first name.
Return ONLY valid JSON: { "subject": "...", "body_html": "..." }`;

      const email = await callClaude(prompt, 'social_post', 500);

      const subject = email.subject || `Quick favour — leave us a review?`;
      const bodyHtml =
        email.body_html ||
        `<p>Hi ${contact_name || 'there'},</p><p>Would you mind leaving us a quick review? <a href="${reviewLink}">Click here</a>. Thanks so much!</p><p>${biz.first_name || biz.business_name}</p>`;

      // Send email
      await sendEmail(contact_email, subject, bodyHtml);

      // Log request
      const reqRow = await sbPost('review_requests', {
        business_id,
        contact_email,
        contact_name,
        platform,
        review_link: reviewLink,
      });

      res.json({ sent: true, request_id: reqRow?.id, subject, platform });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/review-response-generate
  // Generate a Claude-written response draft for a review.
  // Body: { business_id, review_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/review-response-generate', async (req, res) => {
    const { business_id, review_id } = req.body;
    if (!business_id || !review_id) return res.status(400).json({ error: 'business_id and review_id required' });
    if (!isUUID(review_id)) return res.status(400).json({ error: 'review_id must be a valid UUID' });

    try {
      const [bizArr, reviewArr] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=business_name,first_name,email`),
        sbGet('reviews', `id=eq.${review_id}&select=*`),
      ]);
      const biz = bizArr[0];
      const review = reviewArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      if (!review) return res.status(404).json({ error: 'review not found' });

      const stars = review.rating || 5;
      const tone = stars >= 4 ? 'positive' : 'negative';

      const prompt = `Write a professional response to this ${stars}-star review for ${biz.business_name}.
Review: "${review.review_text || 'No text provided'}"
Reviewer: ${review.reviewer_name || 'Valued customer'}

${
  tone === 'positive'
    ? `Thank warmly, mention a specific detail from their review, invite them back. Under 80 words.`
    : `Apologize sincerely, take accountability, offer to resolve offline with contact info. Under 100 words.`
}
Sign as ${biz.first_name || 'The Team'} at ${biz.business_name}.
Return ONLY valid JSON: { "response_text": "..." }`;

      const result = await callClaude(prompt, 'social_post', 400);
      const response_text = result.response_text || result._raw || '';

      await sbPatch('reviews', `id=eq.${review_id}`, { response_draft: response_text, response_status: 'draft_ready' });

      // Notify business owner
      if (biz.email) {
        const html = `<h2>Review Response Draft Ready</h2>
<p><strong>Reviewer:</strong> ${review.reviewer_name || 'Anonymous'} — ${stars}⭐</p>
<p><strong>Review:</strong> "${review.review_text || ''}"</p>
<p><strong>Draft Response:</strong></p><blockquote>${response_text}</blockquote>
<p><a href="https://maroa.ai/reviews" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Publish</a></p>`;
        await sendEmail(
          biz.email,
          `Review response draft ready — ${stars}⭐ from ${review.reviewer_name || 'customer'}`,
          html
        ).catch(() => {});
      }

      try {
        const praise = stars >= 4 ? (review.review_text || '').slice(0, 100) : '';
        const complaint = stars <= 2 ? (review.review_text || '').slice(0, 100) : '';
        if (praise) storeInsight(business_id, 'reviews', 'customer_voice', 'top_praise', praise);
        if (complaint) storeInsight(business_id, 'reviews', 'customer_voice', 'top_complaint', complaint);
      } catch {
        /* soft-fail */
      }
      res.json({ review_id, response_draft: response_text, rating: stars });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/review-response-publish
  // Publish response draft to Google My Business (or mark published locally).
  // Body: { business_id, review_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/review-response-publish', async (req, res) => {
    const { business_id, review_id } = req.body;
    if (!business_id || !review_id) return res.status(400).json({ error: 'business_id and review_id required' });
    if (!isUUID(review_id)) return res.status(400).json({ error: 'review_id must be a valid UUID' });

    try {
      const [bizArr, reviewArr] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=business_name,google_business_id,google_access_token`),
        sbGet('reviews', `id=eq.${review_id}&select=*`),
      ]);
      const biz = bizArr[0];
      const review = reviewArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      if (!review) return res.status(404).json({ error: 'review not found' });

      const responseText = review.response_draft || '';
      let published_via_api = false;

      // Attempt Google My Business API publish
      if (biz.google_business_id && biz.google_access_token && review.platform_review_id) {
        try {
          const gmbResp = await apiRequest(
            'PUT',
            `https://mybusiness.googleapis.com/v4/accounts/${biz.google_business_id}/locations/-/reviews/${review.platform_review_id}/reply`,
            { Authorization: `Bearer ${biz.google_access_token}`, 'Content-Type': 'application/json' },
            { comment: responseText }
          );
          if ([200, 201].includes(gmbResp.status)) published_via_api = true;
        } catch {
          /* soft-fail */
        }
      }

      await sbPatch('reviews', `id=eq.${review_id}`, {
        response_published: responseText,
        response_status: 'published',
      });

      res.json({
        published: true,
        review_id,
        published_via_api,
        note: published_via_api ? 'Posted to Google My Business' : 'Marked published locally (GMB API not connected)',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/reviews-get?business_id=X[&status=X][&platform=X]
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/reviews-get', async (req, res) => {
    const { business_id, status, platform } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      let filter = `business_id=eq.${business_id}&order=review_date.desc.nullslast`;
      if (status) filter += `&response_status=eq.${status}`;
      if (platform) filter += `&platform=eq.${platform}`;

      const reviews = await sbGet('reviews', filter);

      const summary = {
        total: reviews.length,
        pending_response: reviews.filter((r) => r.response_status === 'pending').length,
        draft_ready: reviews.filter((r) => r.response_status === 'draft_ready').length,
        published_response: reviews.filter((r) => r.response_status === 'published').length,
        avg_rating: reviews.length
          ? parseFloat((reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1))
          : null,
        by_sentiment: {
          positive: reviews.filter((r) => r.sentiment === 'positive').length,
          neutral: reviews.filter((r) => r.sentiment === 'neutral').length,
          negative: reviews.filter((r) => r.sentiment === 'negative').length,
        },
      };

      res.json({ reviews, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRINT 3 — PAID ADS MODULE: Ad Creatives + A/B Tests
  // ─────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/ad-creatives-get?business_id=X[&campaign_id=Y]
  // Returns all ad creatives for a business (optionally filtered by campaign).
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/ad-creatives-get', async (req, res) => {
    const { business_id, campaign_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      let filter = `business_id=eq.${business_id}&order=created_at.desc`;
      if (campaign_id) filter += `&campaign_id=eq.${campaign_id}`;

      const creatives = await sbGet('ad_creatives', filter);

      const summary = {
        total: creatives.length,
        active: creatives.filter((c) => c.status === 'active').length,
        winners: creatives.filter((c) => c.is_winner).length,
        avg_ctr: creatives.length
          ? (creatives.reduce((a, c) => a + parseFloat(c.ctr || 0), 0) / creatives.length).toFixed(3)
          : '0.000',
        platforms: [...new Set(creatives.map((c) => c.platform))],
      };

      res.json({ creatives, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/ad-creative-update
  // Update a creative's status, is_winner flag, or performance metrics.
  // Body: { creative_id, [status], [is_winner], [impressions], [clicks], [ctr] }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/ad-creative-update', async (req, res) => {
    const { creative_id, business_id, status, is_winner, impressions, clicks, ctr } = req.body;
    if (!creative_id || !isUUID(String(creative_id)))
      return res.status(400).json({ error: 'valid creative_id required' });
    // business_id is required so we can verify ownership — without it the
    // owner gate no-ops and any tenant could overwrite another's creative.
    if (!business_id || !isUUID(String(business_id)))
      return res.status(400).json({ error: 'valid business_id required' });
    const { assertBusinessOwner } = require('./lib/assertBusinessOwner');
    if (!(await assertBusinessOwner(req, res, business_id, { sbGet, apiError, logger }))) return;
    try {
      const updates = {};
      if (status !== undefined) updates.status = status;
      if (is_winner !== undefined) updates.is_winner = is_winner;
      if (impressions !== undefined) updates.impressions = impressions;
      if (clicks !== undefined) updates.clicks = clicks;
      if (ctr !== undefined) updates.ctr = ctr;

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

      const encCreative = encodeURIComponent(creative_id);
      const encBiz = encodeURIComponent(business_id);
      // Scope by business_id so the patch can only touch the caller's own creative.
      await sbPatch('ad_creatives', `id=eq.${encCreative}&business_id=eq.${encBiz}`, updates);

      // If this creative is being marked as winner, unmark siblings in same campaign
      if (is_winner === true) {
        const rows = await sbGet('ad_creatives', `id=eq.${encCreative}&business_id=eq.${encBiz}&select=campaign_id`);
        const cid = rows[0]?.campaign_id;
        if (cid) {
          await sbPatch('ad_creatives', `campaign_id=eq.${encodeURIComponent(cid)}&id=neq.${encCreative}`, {
            is_winner: false,
          });
        }
      }

      res.json({ success: true, creative_id, updated: updates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/ad-creative-generate
  // Ask Claude Sonnet to generate N fresh ad creatives for a campaign.
  // Body: { business_id, campaign_id, platform, count = 3 }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/ad-creative-generate', async (req, res) => {
    const { business_id, campaign_id, platform = 'meta', count = 3 } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
      const [biz, profileArr] = await Promise.all([
        sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal`
        ).then((r) => r[0]),
        sbGet('business_profiles', `user_id=eq.${business_id}&select=*`).catch(() => []),
      ]);
      if (!biz) return res.status(404).json({ error: 'business not found' });

      // Use master prompt if profile exists
      const adProfile = profileArr[0];
      let masterAdPrompt = '';
      if (adProfile?.physical_locations?.length > 0) {
        try {
          const { buildMasterPrompt: bmp, validateBeforeGeneration: vbg } = require('./services/masterPromptBuilder');
          const errors = vbg(adProfile, 'paid_ad');
          if (errors.length > 0)
            return res.status(400).json({ error: 'profile_incomplete', message: errors[0], all_errors: errors });
          masterAdPrompt = bmp(adProfile, 'paid_ad') + '\n\n';
        } catch {
          /* soft-fail */
        }
      }

      // Pull existing creatives to avoid repetition
      let existingFilter = `business_id=eq.${business_id}&platform=eq.${platform}&order=created_at.desc&limit=5&select=headline,primary_text`;
      const existing = await sbGet('ad_creatives', existingFilter);
      const existingHeadlines = existing
        .map((c) => c.headline)
        .filter(Boolean)
        .join('; ');

      const prompt = `${masterAdPrompt}You are a world-class Meta/Google ad copywriter. Create ${count} distinct ad creative variants for this business.

Business: ${biz.business_name} | Industry: ${biz.industry}
Target Audience: ${biz.target_audience || 'general consumers'}
Brand Tone: ${biz.brand_tone || 'professional'} | Goal: ${biz.marketing_goal || 'generate leads'}
Platform: ${platform}
${existingHeadlines ? `Avoid repeating these headlines: ${existingHeadlines}` : ''}

Return ONLY valid JSON:
{
  "creatives": [
    {
      "headline": "30-char max headline",
      "primary_text": "125-char max body copy",
      "description": "30-char description",
      "cta": "LEARN_MORE|SHOP_NOW|SIGN_UP|CONTACT_US|GET_QUOTE",
      "image_prompt": "detailed Flux AI image prompt for this ad"
    }
  ]
}`;

      // callClaude already returns a parsed object (or { _raw } fallback)
      const parsed = await callClaude(prompt, 'social_post', 1500);

      const variants = Array.isArray(parsed.creatives) ? parsed.creatives.slice(0, count) : [];

      // Persist each generated creative to DB
      const saved = [];
      for (const v of variants) {
        try {
          const row = await sbPost('ad_creatives', {
            business_id,
            campaign_id: campaign_id || null,
            platform,
            headline: v.headline || '',
            primary_text: v.primary_text || '',
            description: v.description || '',
            cta: v.cta || 'LEARN_MORE',
            image_prompt: v.image_prompt || '',
            status: 'active',
          });
          saved.push({ ...v, id: row?.id });
        } catch {
          saved.push(v);
        }
      }

      res.json({ generated: saved.length, creatives: saved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/ab-tests-get?business_id=X
  // Returns A/B test records for a business.
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/ab-tests-get', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const tests = await sbGet('ab_tests', `business_id=eq.${business_id}&order=started_at.desc&limit=20`);

      const summary = {
        total: tests.length,
        with_winner: tests.filter((t) => t.winner).length,
        without_winner: tests.filter((t) => !t.winner).length,
      };

      res.json({ tests, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/ai-brain-run
  // Central AI brain — gathers all data for a business, runs Claude Opus to make
  // strategic decisions, and saves them to businesses.ai_brain_decisions.
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/ai-brain-run', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'AI brain analysis started' });

    setImmediate(async () => {
      try {
        const [bizArr, contentArr, campaignsArr, compArr, snapArr] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=*`),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&order=created_at.desc&limit=10&select=content_theme,status,created_at`
          ),
          sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status,daily_budget,roas,clicks,impressions`),
          sbGet('competitor_insights', `business_id=eq.${business_id}&order=recorded_at.desc&limit=1`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=7`),
        ]);

        const biz = bizArr[0];
        if (!biz) return;
        const comp = compArr[0] || {};

        const totalReach = snapArr.reduce((s, r) => s + (r.reach || 0), 0);
        const totalClicks = snapArr.reduce((s, r) => s + (r.clicks || 0), 0);
        const totalEngagement = snapArr.reduce((s, r) => s + (r.engagement || 0), 0);
        const activeCampaigns = campaignsArr.filter((c) => c.status === 'active');
        const avgRoas = activeCampaigns.length
          ? (activeCampaigns.reduce((s, c) => s + (c.roas || 0), 0) / activeCampaigns.length).toFixed(2)
          : '0';

        const prompt = `You are the central AI brain for ${biz.business_name} (${biz.industry || 'general'}).

CURRENT STATE:
- Plan: ${biz.plan || 'free'}
- Total reach (7d): ${totalReach}
- Total clicks (7d): ${totalClicks}
- Total engagement (7d): ${totalEngagement}
- Active campaigns: ${activeCampaigns.length}
- Average ROAS: ${avgRoas}
- Content pieces (recent 10): ${contentArr.length}
- Content themes used: ${
          contentArr
            .map((c) => c.content_theme)
            .filter(Boolean)
            .join(', ') || 'none'
        }

COMPETITOR INTEL:
- Doing well: ${comp.competitor_doing_well || 'unknown'}
- Gap opportunity: ${comp.gap_opportunity || 'unknown'}

BUSINESS CONTEXT:
- Target audience: ${biz.target_audience || 'general'}
- Marketing goal: ${biz.marketing_goal || 'grow'}
- Brand tone: ${biz.brand_tone || 'professional'}

Based on ALL this data, make strategic decisions for the next 7 days.
Return ONLY valid JSON:
{
  "content_strategy": "what content themes to focus on this week",
  "ad_strategy": "budget allocation and campaign decisions",
  "growth_priorities": ["priority 1", "priority 2", "priority 3"],
  "risk_alerts": ["any concerns"],
  "confidence_score": 0-100
}`;

        const decisions = await callClaude(prompt, 'strategy', 1500, { businessId: business_id });

        await sbPatch('businesses', `id=eq.${business_id}`, {
          ai_brain_decisions: JSON.stringify(decisions),
        });

        log('/webhook/ai-brain-run', `AI brain decisions saved for ${biz.business_name}`);
      } catch (err) {
        console.error('[ai-brain-run ERROR]', err.message);
        await logError(business_id, 'ai-brain-run', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/log-error
  // Centralized error logging endpoint — n8n error-handler workflow posts here.
  // Body: { workflow_name, error_message, business_id? }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/log-error', async (req, res) => {
    res.json({ received: true });
    try {
      const { workflow_name, error_message, business_id } = req.body;
      await sbPost('errors', {
        business_id: business_id || null,
        workflow_name: workflow_name || 'unknown',
        error_message: error_message || 'No error message',
        created_at: new Date().toISOString(),
        resolved: false,
        retry_count: 0,
      });
      if (business_id)
        setImmediate(() => alertOnRepeatedFailure(business_id, workflow_name || 'unknown').catch(() => {}));
      console.log('[log-error] Logged:', workflow_name, error_message);
    } catch (err) {
      console.error('[log-error] Failed to log error:', err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/agent-run  — TRUE AUTONOMOUS AI AGENT
  // Gathers ALL business data, calls Claude Opus for strategic decisions,
  // then EXECUTES those decisions (trigger content, adjust budgets, send alerts).
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/agent-run', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Autonomous agent started — decisions + execution in progress' });

    setImmediate(async () => {
      const actions_taken = [];
      try {
        // ── 1. Gather ALL data ──────────────────────────────────────────────
        const [bizArr, contentArr, campaignsArr, compArr, snapArr, contactsArr, revenueArr, seqArr] = await Promise.all(
          [
            sbGet('businesses', `id=eq.${business_id}&select=*`),
            sbGet(
              'generated_content',
              `business_id=eq.${business_id}&order=created_at.desc&limit=20&select=id,content_theme,status,created_at,performance_score`
            ),
            sbGet(
              'ad_campaigns',
              `business_id=eq.${business_id}&select=id,status,daily_budget,roas,clicks,impressions,total_spend,campaign_type`
            ),
            sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=1`),
            sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=14`),
            sbGet(
              'contacts',
              `business_id=eq.${business_id}&select=id,lead_score,stage,intent_level&order=lead_score.desc&limit=50`
            ),
            sbGet('revenue_attribution', `business_id=eq.${business_id}&order=attributed_at.desc&limit=10`).catch(
              () => []
            ),
            sbGet('email_sequences', `business_id=eq.${business_id}&select=id,name,trigger_type,is_active`).catch(
              () => []
            ),
          ]
        );

        const biz = bizArr[0];
        if (!biz) return;
        const comp = compArr[0] || {};

        // ── 2. Compute metrics ──────────────────────────────────────────────
        const week1 = snapArr.slice(0, 7);
        const week2 = snapArr.slice(7, 14);
        const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
        const thisWeek = {
          reach: sum(week1, 'reach'),
          clicks: sum(week1, 'clicks'),
          engagement: sum(week1, 'engagement'),
        };
        const lastWeek = {
          reach: sum(week2, 'reach'),
          clicks: sum(week2, 'clicks'),
          engagement: sum(week2, 'engagement'),
        };
        const activeCampaigns = campaignsArr.filter((c) => c.status === 'active');
        const avgRoas = activeCampaigns.length
          ? (activeCampaigns.reduce((s, c) => s + (c.roas || 0), 0) / activeCampaigns.length).toFixed(2)
          : '0';
        const totalSpend = campaignsArr.reduce((s, c) => s + (c.total_spend || 0), 0);
        const totalRevenue = revenueArr.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const hotLeads = contactsArr.filter(
          (c) => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy'
        ).length;
        const pendingContent = contentArr.filter((c) => c.status === 'pending_approval').length;
        const topThemes = contentArr
          .filter((c) => (c.performance_score || 0) >= 7)
          .map((c) => c.content_theme)
          .filter(Boolean);

        // ── 3. Claude Opus — full strategic decision ────────────────────────
        const prompt = `You are the autonomous AI marketing agent for ${biz.business_name} (${biz.industry || 'general'}).
You don't just advise — you DECIDE and I will EXECUTE your decisions automatically.

FULL BUSINESS STATE:
- Plan: ${biz.plan || 'free'} | Goal: ${biz.marketing_goal || 'grow'}
- Brand tone: ${biz.brand_tone || 'professional'}
- Target audience: ${biz.target_audience || 'general'}

PERFORMANCE (this week vs last week):
- Reach: ${thisWeek.reach} (was ${lastWeek.reach}) ${thisWeek.reach > lastWeek.reach ? '↑' : '↓'}
- Clicks: ${thisWeek.clicks} (was ${lastWeek.clicks}) ${thisWeek.clicks > lastWeek.clicks ? '↑' : '↓'}
- Engagement: ${thisWeek.engagement} (was ${lastWeek.engagement}) ${thisWeek.engagement > lastWeek.engagement ? '↑' : '↓'}

CAMPAIGNS: ${activeCampaigns.length} active, avg ROAS: ${avgRoas}, total spend: $${totalSpend.toFixed(2)}
REVENUE: $${totalRevenue.toFixed(2)} attributed | LEADS: ${contactsArr.length} total, ${hotLeads} hot
CONTENT: ${pendingContent} pending approval, ${contentArr.length} recent pieces
TOP THEMES (score>=7): ${topThemes.join(', ') || 'none yet'}

COMPETITOR INTEL:
${comp.recommendation || 'No competitor data yet'}

CURRENT AI BRAIN DECISIONS: ${biz.ai_brain_decisions || 'None yet'}

Based on ALL data, return ONLY valid JSON with your decisions:
{
  "content_strategy": "specific themes and angles for this week",
  "ad_strategy": "budget changes and campaign decisions",
  "growth_priorities": ["priority 1", "priority 2", "priority 3"],
  "risk_alerts": ["any urgent concerns"],
  "actions": {
    "generate_content": true/false,
    "pause_low_roas_campaigns": [campaign_ids to pause] or [],
    "increase_budget_campaigns": [{"id":"campaign_id","new_daily":N}] or [],
    "send_win_alert": true/false,
    "trigger_competitor_check": true/false,
    "send_lead_alert": true/false
  },
  "confidence_score": 0-100,
  "reasoning": "why these decisions"
}`;

        const decisions = await callClaude(prompt, 'strategy', 2000, { businessId: business_id });

        // ── 4. EXECUTE decisions automatically ──────────────────────────────
        const acts = decisions.actions || {};

        // 4a. Generate content if decided
        if (acts.generate_content) {
          try {
            await generateInstantContent(business_id);
            actions_taken.push('generated_content');
          } catch (e) {
            actions_taken.push(`content_error: ${e.message}`);
          }
        }

        // 4b. Pause low-ROAS campaigns
        if (Array.isArray(acts.pause_low_roas_campaigns)) {
          for (const cid of acts.pause_low_roas_campaigns) {
            if (isUUID(cid)) {
              try {
                await sbPatch('ad_campaigns', `id=eq.${cid}`, {
                  status: 'paused',
                  last_decision: 'AI Agent paused — low ROAS',
                  last_optimized_at: new Date().toISOString(),
                });
                actions_taken.push(`paused_campaign:${cid}`);
              } catch {
                /* soft-fail */
              }
            }
          }
        }

        // 4c. Increase budget on winning campaigns
        if (Array.isArray(acts.increase_budget_campaigns)) {
          for (const item of acts.increase_budget_campaigns) {
            if (item?.id && isUUID(item.id) && item.new_daily > 0) {
              try {
                await sbPatch('ad_campaigns', `id=eq.${item.id}`, {
                  daily_budget: item.new_daily,
                  last_decision: `AI Agent budget → $${item.new_daily}`,
                  last_optimized_at: new Date().toISOString(),
                });
                actions_taken.push(`budget_change:${item.id}→$${item.new_daily}`);
              } catch {
                /* soft-fail */
              }
            }
          }
        }

        // 4d. Send win alert email
        if (acts.send_win_alert && biz.email) {
          const html = `<h2>🎉 Win Alert from your AI Agent</h2>
<p>Your AI agent detected positive momentum:</p>
<ul><li>Reach: ${thisWeek.reach} (${thisWeek.reach > lastWeek.reach ? 'up' : 'down'} from ${lastWeek.reach})</li>
<li>Active campaigns: ${activeCampaigns.length} | Avg ROAS: ${avgRoas}</li>
<li>Hot leads: ${hotLeads}</li></ul>
<p><strong>Strategy:</strong> ${decisions.content_strategy || ''}</p>
<p><a href="https://maroa.ai/dashboard" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Dashboard</a></p>`;
          await sendEmail(biz.email, `📈 ${biz.business_name} — AI Agent Win Alert`, html).catch(() => {});
          actions_taken.push('sent_win_alert');
        }

        // 4e. Send hot lead alert
        if (acts.send_lead_alert && hotLeads > 0 && biz.email) {
          const html = `<h2>🔥 Hot Lead Alert</h2><p>You have ${hotLeads} leads ready to buy. Check your CRM now!</p>
<p><a href="https://maroa.ai/crm" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Leads</a></p>`;
          await sendEmail(biz.email, `🔥 ${hotLeads} hot leads detected — ${biz.business_name}`, html).catch(() => {});
          actions_taken.push('sent_lead_alert');
        }

        // ── 5. Save decisions + log ─────────────────────────────────────────
        await sbPatch('businesses', `id=eq.${business_id}`, {
          ai_brain_decisions: JSON.stringify(decisions),
          strategy_updated_at: new Date().toISOString(),
        });

        await sbPost('learning_logs', {
          business_id,
          decision_date: new Date().toISOString(),
          decision_data: JSON.stringify(decisions),
          actions_taken: JSON.stringify(actions_taken),
          performance_before: JSON.stringify({ thisWeek, lastWeek, avgRoas, hotLeads }),
        }).catch(() => {});

        log('/webhook/agent-run', `✅ Agent done for ${biz.business_name}: ${actions_taken.length} actions taken`);
      } catch (err) {
        console.error('[agent-run ERROR]', err.message);
        await logError(business_id, 'agent-run', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/optimize-posting-times  — UPGRADE 4: PREDICTIVE POSTING
  // Analyze 30 days of analytics_snapshots, find top engagement hours,
  // update businesses.optimal_posting_times.
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/optimize-posting-times', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Analyzing optimal posting times' });

    setImmediate(async () => {
      try {
        const [bizArr, snapshots] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,email`),
          sbGet(
            'analytics_snapshots',
            `business_id=eq.${business_id}&order=snapshot_date.desc&limit=30&select=snapshot_date,engagement,reach,clicks,impressions`
          ),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        // If we have snapshots, ask Claude to analyze patterns
        const prompt = `Analyze these daily analytics snapshots for ${biz.business_name} (${biz.industry || 'business'}) and determine the optimal posting schedule.

DATA (last 30 days):
${JSON.stringify(snapshots.map((s) => ({ date: s.snapshot_date, engagement: s.engagement || 0, reach: s.reach || 0, clicks: s.clicks || 0 })))}

Based on engagement patterns (day of week, implied time windows), recommend:
1. The top 3 best days/hours to post
2. Days/hours to avoid
3. Platform-specific recommendations

Return ONLY valid JSON:
{
  "optimal_times": [
    {"day": "Monday", "hour": 9, "reason": "highest engagement window"},
    {"day": "Wednesday", "hour": 12, "reason": "..."},
    {"day": "Friday", "hour": 17, "reason": "..."}
  ],
  "avoid_times": [{"day": "Sunday", "hour": 22, "reason": "..."}],
  "platform_tips": {"instagram": "...", "facebook": "...", "linkedin": "..."},
  "confidence": 0-100
}`;

        const result = await callClaude(prompt, 'social_post', 1000);

        await sbPatch('businesses', `id=eq.${business_id}`, {
          optimal_posting_times: JSON.stringify(result),
        });

        log('/webhook/optimize-posting-times', `✅ Optimal times saved for ${biz.business_name}`);
      } catch (err) {
        console.error('[optimize-posting-times ERROR]', err.message);
        await logError(business_id, 'optimize-posting-times', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/competitor-alert-check  — UPGRADE 5: REAL-TIME ALERTS
  // Compare last 2 competitor reports. If major change detected, email alert.
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/competitor-alert-check', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Checking for competitor changes' });

    setImmediate(async () => {
      try {
        const [bizArr, reports] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,email`),
          sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=2`),
        ]);
        const biz = bizArr[0];
        if (!biz || reports.length < 2) return log('/webhook/competitor-alert-check', 'Not enough reports to compare');

        const [latest, previous] = reports;

        const prompt = `Compare these two competitor intelligence reports for ${biz.business_name} and detect significant changes.

LATEST REPORT (${latest.report_date || latest.created_at}):
- Content themes: ${JSON.stringify(latest.content_themes || [])}
- New offers: ${JSON.stringify(latest.new_offers || [])}
- Ad angles: ${JSON.stringify(latest.ad_angles || [])}
- Pricing changes: ${JSON.stringify(latest.pricing_changes || [])}

PREVIOUS REPORT (${previous.report_date || previous.created_at}):
- Content themes: ${JSON.stringify(previous.content_themes || [])}
- New offers: ${JSON.stringify(previous.new_offers || [])}
- Ad angles: ${JSON.stringify(previous.ad_angles || [])}
- Pricing changes: ${JSON.stringify(previous.pricing_changes || [])}

Identify NEW changes between the two reports. Only flag genuinely significant shifts.
Return ONLY valid JSON:
{
  "has_major_change": true/false,
  "changes": [{"type": "pricing/content/ads/offer", "description": "what changed", "severity": "high/medium/low", "recommended_action": "what to do"}],
  "summary": "1-2 sentence summary of changes"
}`;

        const result = await callClaude(prompt, 'social_post', 800);

        if (result.has_major_change && biz.email) {
          const changesList = (result.changes || [])
            .map((c) => `<li><strong>[${c.severity}]</strong> ${c.description}<br/>→ ${c.recommended_action}</li>`)
            .join('');
          const html = `<h2>⚡ Competitor Alert — ${biz.business_name}</h2>
<p>${result.summary || 'Significant competitor changes detected.'}</p>
<ul>${changesList}</ul>
<p><a href="https://maroa.ai/competitors" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Full Report</a></p>`;
          await sendEmail(biz.email, `⚡ Competitor change detected — ${biz.business_name}`, html);
          log('/webhook/competitor-alert-check', `⚡ Alert sent for ${biz.business_name}: ${result.summary}`);
        } else {
          log('/webhook/competitor-alert-check', `No major changes for ${biz.business_name}`);
        }
      } catch (err) {
        console.error('[competitor-alert-check ERROR]', err.message);
        await logError(business_id, 'competitor-alert-check', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/weekly-strategy-update  — UPGRADE 7: STRATEGY EVOLUTION
  // Compares this week vs last week, Claude Opus evolves strategy.
  // Body: { business_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/weekly-strategy-update', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Weekly strategy evolution started' });

    setImmediate(async () => {
      try {
        const [bizArr, snapshots, contentArr, compArr] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=*`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=14`),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&order=created_at.desc&limit=20&select=content_theme,status,performance_score`
          ),
          sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=1`),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        const week1 = snapshots.slice(0, 7);
        const week2 = snapshots.slice(7, 14);
        const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
        const thisWeek = {
          reach: sum(week1, 'reach'),
          clicks: sum(week1, 'clicks'),
          engagement: sum(week1, 'engagement'),
        };
        const lastWeek = {
          reach: sum(week2, 'reach'),
          clicks: sum(week2, 'clicks'),
          engagement: sum(week2, 'engagement'),
        };

        const topContent = contentArr
          .filter((c) => (c.performance_score || 0) >= 7)
          .map((c) => c.content_theme)
          .filter(Boolean);
        const lowContent = contentArr
          .filter((c) => (c.performance_score || 0) > 0 && (c.performance_score || 0) < 4)
          .map((c) => c.content_theme)
          .filter(Boolean);

        const prompt = `You are the chief marketing strategist AI for ${biz.business_name} (${biz.industry || 'general'}).

CURRENT STRATEGY: ${biz.marketing_strategy || 'No strategy set yet'}
CURRENT BEST THEMES: ${biz.best_performing_themes || '[]'}
CURRENT WORST THEMES: ${biz.worst_performing_themes || '[]'}

THIS WEEK PERFORMANCE:
- Reach: ${thisWeek.reach} | Clicks: ${thisWeek.clicks} | Engagement: ${thisWeek.engagement}

LAST WEEK PERFORMANCE:
- Reach: ${lastWeek.reach} | Clicks: ${lastWeek.clicks} | Engagement: ${lastWeek.engagement}

TREND: Reach ${thisWeek.reach >= lastWeek.reach ? 'UP' : 'DOWN'}, Clicks ${thisWeek.clicks >= lastWeek.clicks ? 'UP' : 'DOWN'}, Engagement ${thisWeek.engagement >= lastWeek.engagement ? 'UP' : 'DOWN'}

HIGH-PERFORMING CONTENT THEMES: ${topContent.join(', ') || 'none yet'}
LOW-PERFORMING CONTENT THEMES: ${lowContent.join(', ') || 'none yet'}

COMPETITOR RECOMMENDATION: ${compArr[0]?.recommendation || 'No data'}

BUSINESS CONTEXT:
- Target audience: ${biz.target_audience || 'general'}
- Goal: ${biz.marketing_goal || 'grow'}
- Brand tone: ${biz.brand_tone || 'professional'}

Evolve the marketing strategy based on what worked and what didn't.
Double down on winning themes, abandon losing themes, adapt to competitor moves.
Return ONLY valid JSON:
{
  "marketing_strategy": "full evolved strategy paragraph (200+ words)",
  "best_performing_themes": ["theme1", "theme2", "theme3"],
  "worst_performing_themes": ["theme1", "theme2"],
  "audience_insights": "what we learned about the audience this week",
  "weekly_forecast": {
    "expected_reach_change": "+15%",
    "content_focus": "what to focus on",
    "risk_level": "low/medium/high"
  },
  "key_changes": ["change 1 from last strategy", "change 2"]
}`;

        const result = await callClaude(prompt, 'strategy', 2000, { businessId: business_id });

        const updates = { strategy_updated_at: new Date().toISOString() };
        if (result.marketing_strategy) updates.marketing_strategy = result.marketing_strategy;
        if (result.best_performing_themes)
          updates.best_performing_themes = JSON.stringify(result.best_performing_themes);
        if (result.worst_performing_themes)
          updates.worst_performing_themes = JSON.stringify(result.worst_performing_themes);
        if (result.weekly_forecast) updates.weekly_forecast = JSON.stringify(result.weekly_forecast);

        await sbPatch('businesses', `id=eq.${business_id}`, updates);

        // Log the strategy evolution
        await sbPost('learning_logs', {
          business_id,
          decision_date: new Date().toISOString(),
          decision_data: JSON.stringify(result),
          actions_taken: JSON.stringify(result.key_changes || []),
          performance_before: JSON.stringify({ thisWeek, lastWeek }),
        }).catch(() => {});

        try {
          storeInsight(
            business_id,
            'strategy',
            'content_strategy',
            'content_themes',
            (result.best_performing_themes || []).join(', ')
          );
          storeInsight(
            business_id,
            'strategy',
            'content_strategy',
            'weekly_focus',
            result.marketing_strategy ? result.marketing_strategy.slice(0, 200) : ''
          );
        } catch {
          /* soft-fail */
        }
        log('/webhook/weekly-strategy-update', `✅ Strategy evolved for ${biz.business_name}`);
      } catch (err) {
        console.error('[weekly-strategy-update ERROR]', err.message);
        await logError(business_id, 'weekly-strategy-update', err.message, req.body).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/attribute-revenue  — UPGRADE 8: REVENUE ATTRIBUTION
  // Accept { business_id, revenue_amount, source, campaign_id?, content_id? }
  // Store in revenue_attribution, update businesses.estimated_revenue.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/attribute-revenue', async (req, res) => {
    const { business_id, revenue_amount, source, campaign_id, content_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!revenue_amount || isNaN(Number(revenue_amount)))
      return res.status(400).json({ error: 'revenue_amount required (number)' });
    if (!source) return res.status(400).json({ error: 'source required' });

    try {
      const row = await sbPost('revenue_attribution', {
        business_id,
        amount: Number(revenue_amount),
        source,
        campaign_id: campaign_id || null,
        content_id: content_id || null,
      });

      // Recalculate total estimated revenue
      const allRevenue = await sbGet('revenue_attribution', `business_id=eq.${business_id}&select=amount`);
      const total = allRevenue.reduce((s, r) => s + (Number(r.amount) || 0), 0);

      await sbPatch('businesses', `id=eq.${business_id}`, {
        estimated_revenue: total,
      });

      res.json({ success: true, attribution_id: row?.id, total_revenue: total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // MAXIMUM INTELLIGENCE LAYER — LEVELS 1-10
  // ═════════════════════════════════════════════════════════════════════════════

  // ── Helper: getBusinessMemory ─────────────────────────────────────────────────
  async function getBusinessMemory(businessId) {
    const [learningLogs, topContent, failedContent, bizArr] = await Promise.all([
      sbGet('learning_logs', `business_id=eq.${businessId}&order=created_at.desc&limit=10`),
      sbGet(
        'generated_content',
        `business_id=eq.${businessId}&performance_score=gte.7&order=performance_score.desc&limit=5`
      ).catch(() => []),
      sbGet(
        'generated_content',
        `business_id=eq.${businessId}&performance_score=lte.3&performance_score=gt.0&limit=5`
      ).catch(() => []),
      sbGet('businesses', `id=eq.${businessId}`),
    ]);
    const biz = bizArr[0] || {};
    return {
      what_worked: topContent.map((c) => ({
        theme: c.content_theme,
        score: c.performance_score,
        caption: (c.instagram_caption || '').slice(0, 100),
      })),
      what_failed: failedContent.map((c) => ({ theme: c.content_theme, score: c.performance_score })),
      business_profile: {
        name: biz.business_name,
        industry: biz.industry,
        goal: biz.marketing_goal,
        tone: biz.brand_tone,
        plan: biz.plan,
      },
      past_decisions: learningLogs
        .map((l) => {
          try {
            const d = typeof l.decision_data === 'string' ? JSON.parse(l.decision_data) : l.decision_data;
            return d?.learning;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, 5),
      best_performing_themes: biz.best_performing_themes || '[]',
      worst_performing_themes: biz.worst_performing_themes || '[]',
      audience_insights: biz.audience_insights || biz.audience_insights_full || '{}',
    };
  }

  // ── Helper: perceiveEnvironment ───────────────────────────────────────────────
  async function perceiveEnvironment(businessId) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const [analytics, campaigns, leads, competitors, errors, pendingContent] = await Promise.all([
      sbGet('analytics_snapshots', `business_id=eq.${businessId}&snapshot_date=gte.${yesterday}`).catch(() => []),
      sbGet('ad_campaigns', `business_id=eq.${businessId}&status=eq.active`).catch(() => []),
      sbGet('contacts', `business_id=eq.${businessId}&lead_score=gte.50&order=lead_score.desc&limit=10`).catch(
        () => []
      ),
      sbGet('competitor_reports', `business_id=eq.${businessId}&order=created_at.desc&limit=1`).catch(() => []),
      sbGet('errors', `business_id=eq.${businessId}&resolved=eq.false&order=created_at.desc&limit=5`).catch(() => []),
      sbGet('generated_content', `business_id=eq.${businessId}&status=eq.pending_approval`).catch(() => []),
    ]);
    return {
      todays_reach: analytics.reduce((s, a) => s + (a.reach || 0), 0),
      todays_engagement: analytics.reduce((s, a) => s + (a.engagement || 0), 0),
      active_campaigns: campaigns.length,
      total_ad_spend_today: campaigns.reduce((s, c) => s + (c.daily_budget || 0), 0),
      hot_leads: leads.length,
      top_lead_scores: leads.slice(0, 3).map((l) => ({ score: l.lead_score, intent: l.intent_level })),
      competitor_latest: competitors[0]?.recommendation || 'No recent data',
      system_errors: errors.length,
      error_details: errors.slice(0, 2).map((e) => e.error_message),
      content_awaiting_approval: pendingContent.length,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Helper: executePlan ───────────────────────────────────────────────────────
  async function executePlan(businessId, executionPlan) {
    const SELF = `https://maroa-api-production.up.railway.app`;
    const actions = [];
    if (!Array.isArray(executionPlan)) return actions;
    for (const step of executionPlan) {
      try {
        const act = (step.action || '').toLowerCase();
        if (act.includes('content') || act === 'generate_content') {
          apiRequest(
            'POST',
            `${SELF}/webhook/instant-content`,
            { 'Content-Type': 'application/json' },
            { business_id: businessId }
          ).catch(() => {});
          actions.push({ action: 'content_generated', details: step.details || '' });
        } else if (act.includes('optimize') || act === 'optimize_campaign') {
          apiRequest(
            'POST',
            `${SELF}/webhook/meta-campaign-optimize`,
            { 'Content-Type': 'application/json' },
            { business_id: businessId }
          ).catch(() => {});
          actions.push({ action: 'campaigns_optimized' });
        } else if (act.includes('competitor') || act === 'analyze_competitors') {
          apiRequest(
            'POST',
            `${SELF}/webhook/competitor-analyze`,
            { 'Content-Type': 'application/json' },
            { business_id: businessId }
          ).catch(() => {});
          actions.push({ action: 'competitor_analysis_triggered' });
        } else if (act.includes('lead') || act.includes('followup') || act === 'send_lead_followup') {
          apiRequest(
            'POST',
            `${SELF}/webhook/email-sequence-process`,
            { 'Content-Type': 'application/json' },
            {}
          ).catch(() => {});
          actions.push({ action: 'lead_followup_triggered' });
        } else if (act.includes('seo')) {
          apiRequest(
            'POST',
            `${SELF}/webhook/seo-audit`,
            { 'Content-Type': 'application/json' },
            { business_id: businessId }
          ).catch(() => {});
          actions.push({ action: 'seo_audit_triggered' });
        } else {
          actions.push({ action: act, details: step.details || '', status: 'noted' });
        }
      } catch (err) {
        console.error('[executePlan] Step failed:', step.action, err.message);
      }
    }
    return actions;
  }

  // ── Helper: updateBusinessMemory ──────────────────────────────────────────────
  async function updateBusinessMemory(businessId, learning, currentState) {
    await sbPost('learning_logs', {
      business_id: businessId,
      decision_date: new Date().toISOString(),
      decision_data: JSON.stringify({ learning }),
      actions_taken: JSON.stringify([]),
      performance_before: JSON.stringify(currentState),
    }).catch(() => {});

    if (learning?.pattern_detected) {
      try {
        const bizArr = await sbGet('businesses', `id=eq.${businessId}&select=audience_insights`);
        const existing = (() => {
          try {
            return JSON.parse(bizArr[0]?.audience_insights || '{}');
          } catch {
            return {};
          }
        })();
        await sbPatch('businesses', `id=eq.${businessId}`, {
          audience_insights: JSON.stringify({
            ...existing,
            latest_pattern: learning.pattern_detected,
            updated_at: new Date().toISOString(),
          }),
        });
      } catch {
        /* soft-fail */
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 1: POST /webhook/master-agent  — SELF-IMPROVING AI BRAIN
  // Full reasoning loop: Memory → Perception → Reasoning → Execution → Learning
  // ─────────────────────────────────────────────────────────────────────────────
  async function masterAgent(businessId) {
    const memory = await getBusinessMemory(businessId);
    const currentState = await perceiveEnvironment(businessId);

    const prompt = `You are the autonomous marketing brain for ${memory.business_profile.name || 'this business'} (${memory.business_profile.industry || 'general'}).

Think step by step like a senior marketing director.

MEMORY (what we learned from the past):
${JSON.stringify(memory, null, 1)}

CURRENT STATE (what is happening right now):
${JSON.stringify(currentState, null, 1)}

STEP 1 - DIAGNOSE: What is the current marketing health? (1-10 score with specific reasons)
STEP 2 - IDENTIFY: What is the single highest leverage action right now?
STEP 3 - PLAN: Exact execution steps for the next 24 hours. Each step must have an "action" field that is one of: generate_content, optimize_campaign, analyze_competitors, send_lead_followup, run_seo_audit. And a "details" field.
STEP 4 - PREDICT: Expected outcome if plan is executed (with confidence %)
STEP 5 - LEARN: What should be remembered for next time?

Return ONLY valid JSON:
{
  "diagnosis": { "score": 1-10, "strengths": [], "weaknesses": [], "opportunities": [], "threats": [] },
  "highest_leverage_action": { "what": "string", "why": "string", "expected_impact": "string" },
  "execution_plan": [{ "time": "09:00", "action": "generate_content", "details": "string" }],
  "prediction": { "expected_reach": 0, "expected_leads": 0, "confidence_pct": 0 },
  "learning": { "remember_this": "string", "avoid_this": "string", "pattern_detected": "string" },
  "agent_summary": "1-2 sentence summary"
}`;

    const plan = await callClaude(prompt, 'strategy', 4000, { businessId });

    // EXECUTION
    const actions = await executePlan(businessId, plan.execution_plan);

    // LEARNING
    await updateBusinessMemory(businessId, plan.learning, currentState);

    // DASHBOARD UPDATE
    await sbPatch('businesses', `id=eq.${businessId}`, {
      ai_brain_decisions: JSON.stringify(plan),
      strategy_updated_at: new Date().toISOString(),
    }).catch(() => {});

    // Save full session
    await sbPost('learning_logs', {
      business_id: businessId,
      decision_date: new Date().toISOString(),
      decision_data: JSON.stringify(plan),
      actions_taken: JSON.stringify(actions),
      performance_before: JSON.stringify(currentState),
    }).catch(() => {});

    return plan;
  }

  app.post('/webhook/master-agent', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });
    res.json({ received: true, message: 'Master agent started — full reasoning loop in progress' });

    setImmediate(async () => {
      try {
        log('/webhook/master-agent', `Starting for ${business_id}`);
        const result = await masterAgent(business_id);
        log(
          '/webhook/master-agent',
          `✅ Complete. Score: ${result.diagnosis?.score} Action: ${result.highest_leverage_action?.what}`
        );
      } catch (err) {
        console.error('[master-agent] Fatal error:', err.message);
        await logError(business_id, 'master-agent', err.message).catch(() => {});
      }
    });
  });

  app.post('/webhook/master-agent-all', requireWebhookSource, async (req, res) => {
    res.json({ received: true, message: 'Running master agent for all active businesses' });
    setImmediate(async () => {
      try {
        const businesses = await sbGet('businesses', 'is_active=eq.true&select=id');
        log('/webhook/master-agent-all', `Running for ${businesses.length} businesses`);
        for (const biz of businesses) {
          try {
            await masterAgent(biz.id);
          } catch (e) {
            console.error(`[master-agent-all] ${biz.id} error:`, e.message);
          }
          await new Promise((r) => setTimeout(r, 10000));
        }
      } catch (err) {
        console.error('[master-agent-all]', err.message);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 2: POST /webhook/measure-content-performance
  // Measures all content published >24h ago with no score yet.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/measure-content-performance', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [bizArr, unmeasured] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=meta_access_token,facebook_page_id`),
        sbGet(
          'generated_content',
          `business_id=eq.${business_id}&published_at=lt.${cutoff}&performance_score=eq.0&status=eq.published&limit=20`
        ),
      ]);
      const biz = bizArr[0];
      if (!biz?.meta_access_token || !biz?.facebook_page_id)
        return res.json({ measured: 0, reason: 'Meta not connected' });

      let measured = 0,
        high = 0,
        low = 0;
      // Fetch recent page posts
      const postsResp = await apiRequest(
        'GET',
        `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/posts?fields=id,message,created_time,insights.metric(post_impressions,post_engaged_users)&limit=20&access_token=${biz.meta_access_token}`,
        {}
      );
      const fbPosts = postsResp.body?.data || [];

      for (const content of unmeasured) {
        // Try to match a FB post to this content by time proximity
        const pubTime = new Date(content.published_at).getTime();
        const match = fbPosts.find((p) => Math.abs(new Date(p.created_time).getTime() - pubTime) < 12 * 60 * 60 * 1000);
        if (!match) continue;

        const metrics = match.insights?.data || [];
        const impressions = metrics.find((m) => m.name === 'post_impressions')?.values?.[0]?.value || 0;
        const engaged = metrics.find((m) => m.name === 'post_engaged_users')?.values?.[0]?.value || 0;
        const perfScore = impressions > 0 ? Math.min(10, Math.round((engaged / impressions) * 100)) : 0;

        await sbPatch('generated_content', `id=eq.${content.id}`, {
          performance_score: perfScore,
          total_reach: impressions,
          facebook_post_id: match.id,
        });
        measured++;

        if (perfScore >= 7) {
          high++;
          // Store in brand memory
          try {
            if (OPENAI_API_KEY && PINECONE_API_KEY && PINECONE_HOST) {
              const text = content.instagram_caption || content.facebook_post || '';
              if (text) {
                const vector = await getEmbedding(text);
                await pineconeUpsert([
                  {
                    id: content.id,
                    values: vector,
                    metadata: {
                      businessId: business_id,
                      contentType: 'social_post',
                      text: text.slice(0, 1000),
                      score: perfScore,
                    },
                  },
                ]);
              }
            }
          } catch {
            /* soft-fail */
          }
        } else if (perfScore <= 2) {
          low++;
          await sbPost('learning_logs', {
            business_id,
            decision_date: new Date().toISOString(),
            decision_data: JSON.stringify({ learning: { avoid_this: content.content_theme, score: perfScore } }),
            performance_before: JSON.stringify({ impressions, engaged }),
          }).catch(() => {});
        }
      }

      res.json({ measured, high_performers: high, low_performers: low, total_checked: unmeasured.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 3: POST /webhook/score-content-before-posting
  // Predictive scoring — Claude rates content before it goes live.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/score-content-before-posting', async (req, res) => {
    const { business_id, caption, image_url } = req.body;
    if (!business_id || !caption) return res.status(400).json({ error: 'business_id and caption required' });

    try {
      const bizArr = await sbGet(
        'businesses',
        `id=eq.${business_id}&select=business_name,brand_tone,target_audience,best_performing_themes`
      );
      const biz = bizArr[0] || {};
      const brandExamples = await getBrandExamples(business_id, 'social_post', caption.slice(0, 200));
      const recentContent = await sbGet(
        'generated_content',
        `business_id=eq.${business_id}&order=created_at.desc&limit=5&select=instagram_caption,content_theme`
      );

      const prompt = `${brandExamples}Rate this content BEFORE posting on a 1-10 scale.

BUSINESS: ${biz.business_name || 'Business'} | TONE: ${biz.brand_tone || 'professional'} | AUDIENCE: ${biz.target_audience || 'general'}
BEST THEMES: ${biz.best_performing_themes || 'unknown'}
RECENT POSTS (to check uniqueness): ${recentContent.map((c) => (c.instagram_caption || '').slice(0, 80)).join(' | ')}

CONTENT TO EVALUATE:
"${caption}"
${image_url ? `Image: ${image_url}` : 'No image'}

Rate 1-10 on each:
1. Brand voice match (does it sound like this brand?)
2. Engagement potential (hook strength, CTA, emotional pull)
3. Uniqueness vs recent posts (is it fresh or repetitive?)
4. Audience relevance (will target audience care?)

Return ONLY valid JSON:
{
  "total_score": 1-10,
  "breakdown": { "brand_voice": N, "engagement_potential": N, "uniqueness": N, "audience_relevance": N },
  "recommendation": "post" | "revise" | "reject",
  "improvement": "specific suggestion if score < 6",
  "reasoning": "1-2 sentences"
}`;

      const result = await callClaude(prompt, 'social_post', 800);

      // If score < 6, auto-generate improved version
      let improved_caption = null;
      if ((result.total_score || 0) < 6 && result.improvement) {
        const improvePrompt = `Rewrite this social media caption to be MUCH better. Apply this feedback: "${result.improvement}"
Original: "${caption}"
Brand tone: ${biz.brand_tone || 'professional'} | Audience: ${biz.target_audience || 'general'}
Return ONLY valid JSON: {"improved_caption": "the rewritten caption"}`;
        const improved = await callClaude(improvePrompt, 'social_post', 500);
        improved_caption = improved.improved_caption || null;
      }

      res.json({
        score: result.total_score,
        breakdown: result.breakdown,
        recommendation: result.recommendation,
        improvement: result.improvement,
        improved_caption,
        reasoning: result.reasoning,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 4: POST /webhook/analyze-audience
  // 90-day deep audience intelligence analysis.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/analyze-audience', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Audience analysis started — 90 day deep dive' });

    setImmediate(async () => {
      try {
        const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
        const [bizArr, snapshots, contentArr] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone`),
          sbGet(
            'analytics_snapshots',
            `business_id=eq.${business_id}&snapshot_date=gte.${ninetyAgo}&order=snapshot_date.asc`
          ),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&performance_score=gt.0&order=performance_score.desc&limit=30&select=content_theme,performance_score,created_at,status`
          ),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        // Group snapshots by day of week
        const byDay = {};
        for (const s of snapshots) {
          const day = new Date(s.snapshot_date).toLocaleDateString('en-US', { weekday: 'long' });
          if (!byDay[day]) byDay[day] = { engagement: 0, reach: 0, count: 0 };
          byDay[day].engagement += s.engagement || 0;
          byDay[day].reach += s.reach || 0;
          byDay[day].count++;
        }
        const dayAvgs = Object.entries(byDay)
          .map(([day, d]) => ({
            day,
            avg_engagement: d.count > 0 ? (d.engagement / d.count).toFixed(1) : 0,
            avg_reach: d.count > 0 ? (d.reach / d.count).toFixed(1) : 0,
          }))
          .sort((a, b) => b.avg_engagement - a.avg_engagement);

        // Content performance by theme
        const byTheme = {};
        for (const c of contentArr) {
          const t = c.content_theme || 'unknown';
          if (!byTheme[t]) byTheme[t] = { total_score: 0, count: 0 };
          byTheme[t].total_score += c.performance_score || 0;
          byTheme[t].count++;
        }
        const themeScores = Object.entries(byTheme)
          .map(([theme, d]) => ({ theme, avg_score: (d.total_score / d.count).toFixed(1), count: d.count }))
          .sort((a, b) => b.avg_score - a.avg_score);

        // Growth rate (week over week reach)
        const weeks = [];
        for (let i = 0; i < snapshots.length; i += 7) {
          const weekSlice = snapshots.slice(i, i + 7);
          weeks.push(weekSlice.reduce((s, r) => s + (r.reach || 0), 0));
        }
        const growthRates = weeks
          .slice(1)
          .map((w, i) => (weeks[i] > 0 ? (((w - weeks[i]) / weeks[i]) * 100).toFixed(1) + '%' : 'N/A'));

        const prompt = `Based on 90 days of data for ${biz.business_name} (${biz.industry || 'business'}), describe the audience in detail.

ENGAGEMENT BY DAY OF WEEK: ${JSON.stringify(dayAvgs)}
CONTENT PERFORMANCE BY THEME: ${JSON.stringify(themeScores)}
WEEKLY GROWTH RATES: ${JSON.stringify(growthRates)}
TOTAL SNAPSHOTS: ${snapshots.length} days | CONTENT MEASURED: ${contentArr.length} pieces

What do they respond to? When are they most active? What content resonates?
Return ONLY valid JSON:
{
  "audience_profile": "detailed description of who this audience is and what they want",
  "best_day_to_post": "day",
  "best_content_types": ["theme1", "theme2", "theme3"],
  "worst_content_types": ["theme1", "theme2"],
  "growth_trajectory": "growing/stagnant/declining",
  "growth_rate_weekly": "X%",
  "optimal_posting_times": [{"day":"Monday","hour":9,"reason":"..."},{"day":"Wednesday","hour":12,"reason":"..."},{"day":"Friday","hour":17,"reason":"..."}],
  "key_insight": "the single most important thing about this audience",
  "recommendations": ["rec 1", "rec 2", "rec 3"]
}`;

        const result = await callClaude(prompt, 'strategy', 1500, { businessId: business_id });

        await sbPatch('businesses', `id=eq.${business_id}`, {
          audience_insights_full: JSON.stringify(result),
          optimal_posting_times: JSON.stringify(result.optimal_posting_times || []),
          best_performing_themes: JSON.stringify(result.best_content_types || []),
          worst_performing_themes: JSON.stringify(result.worst_content_types || []),
        });

        try {
          storeInsight(business_id, 'audience', 'audience_intelligence', 'best_day', result.best_day_to_post || '');
          storeInsight(
            business_id,
            'audience',
            'audience_intelligence',
            'growth_trajectory',
            result.growth_trajectory || ''
          );
          storeInsight(business_id, 'audience', 'audience_intelligence', 'key_insight', result.key_insight || '');
        } catch {
          /* soft-fail */
        }
        log('/webhook/analyze-audience', `✅ Audience analysis complete for ${biz.business_name}`);
      } catch (err) {
        console.error('[analyze-audience ERROR]', err.message);
        await logError(business_id, 'analyze-audience', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 5: POST /webhook/build-competitive-moat
  // Finds content gaps competitors aren't covering that our audience would love.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/build-competitive-moat', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Building competitive moat — finding content gaps' });

    setImmediate(async () => {
      try {
        const [bizArr, compReports, topContent] = await Promise.all([
          sbGet(
            'businesses',
            `id=eq.${business_id}&select=business_name,industry,target_audience,best_performing_themes,brand_tone`
          ),
          sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=3`),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&performance_score=gte.6&order=performance_score.desc&limit=10&select=content_theme,instagram_caption,performance_score`
          ),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        const compThemes = compReports.flatMap((r) => r.content_themes || []);
        const ourThemes = topContent.map((c) => c.content_theme).filter(Boolean);

        const prompt = `You are a competitive strategist for ${biz.business_name} (${biz.industry || 'business'}).

COMPETITOR CONTENT THEMES (what they cover): ${JSON.stringify([...new Set(compThemes)])}
COMPETITOR RECOMMENDATIONS: ${compReports
          .map((r) => r.recommendation)
          .filter(Boolean)
          .join(' | ')}

OUR TOP PERFORMING THEMES: ${JSON.stringify([...new Set(ourThemes)])}
OUR BEST CONTENT: ${topContent
          .slice(0, 3)
          .map((c) => `"${(c.instagram_caption || '').slice(0, 100)}..." (score: ${c.performance_score})`)
          .join('\n')}

OUR AUDIENCE: ${biz.target_audience || 'general'} | TONE: ${biz.brand_tone || 'professional'}

Find the GAP: What valuable content are competitors NOT creating that our audience would love?
Give 5 specific, differentiated content ideas that would build a competitive moat.

Return ONLY valid JSON:
{
  "content_opportunities": [
    { "topic": "specific topic", "angle": "unique angle", "hook": "opening line", "why_unique": "why competitors can't copy this", "expected_engagement": "high/medium" }
  ],
  "competitive_advantage": "our key differentiator",
  "moat_strategy": "how to build an unfair advantage over time",
  "gaps_found": ["gap 1", "gap 2"]
}`;

        const result = await callClaude(prompt, 'strategy', 1500, { businessId: business_id });

        await sbPatch('businesses', `id=eq.${business_id}`, {
          content_opportunities: JSON.stringify(result.content_opportunities || []),
          competitive_moat: JSON.stringify(result),
        });

        try {
          storeInsight(business_id, 'moat', 'competitive_intelligence', 'moat_strategy', result.moat_strategy || '');
          storeInsight(
            business_id,
            'moat',
            'competitive_intelligence',
            'content_gaps',
            (result.content_opportunities || [])
              .slice(0, 3)
              .map((o) => o.topic || o)
              .join('; ')
          );
        } catch {
          /* soft-fail */
        }
        log(
          '/webhook/build-competitive-moat',
          `✅ Moat built for ${biz.business_name}: ${(result.content_opportunities || []).length} opportunities`
        );
      } catch (err) {
        console.error('[build-competitive-moat ERROR]', err.message);
        await logError(business_id, 'build-competitive-moat', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 8: POST /webhook/orchestrate-campaign
  // ONE-CLICK full marketing campaign across ALL channels.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/orchestrate-campaign', async (req, res) => {
    const { business_id, campaign_goal, budget = 500, duration_days = 14 } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Orchestrating multi-channel campaign' });

    setImmediate(async () => {
      try {
        const bizArr = await sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal,best_performing_themes`
        );
        const biz = bizArr[0];
        if (!biz) return;

        const prompt = `Design a complete multi-channel marketing campaign for ${biz.business_name} (${biz.industry || 'business'}).

GOAL: ${campaign_goal || biz.marketing_goal || 'generate leads'}
BUDGET: $${budget} over ${duration_days} days
AUDIENCE: ${biz.target_audience || 'general'}
TONE: ${biz.brand_tone || 'professional'}
BEST THEMES: ${biz.best_performing_themes || 'unknown'}

Create a COORDINATED campaign across Instagram, Facebook, Email, and Google Ads.
Return ONLY valid JSON:
{
  "campaign_name": "catchy campaign name",
  "campaign_theme": "overarching theme",
  "duration_days": ${duration_days},
  "channels": {
    "instagram": { "posts_per_week": 3, "content_angle": "string", "cta": "string" },
    "facebook": { "posts_per_week": 2, "ad_budget_pct": 40, "audience": "string" },
    "email": { "sequence_name": "string", "emails": 3, "trigger": "signup" },
    "google_ads": { "keywords": ["kw1","kw2","kw3"], "budget_pct": 30, "landing_page_focus": "string" }
  },
  "content_calendar": [
    { "day": 1, "channel": "instagram", "content_type": "post", "topic": "string", "hook": "string" }
  ],
  "success_metrics": { "target_reach": 0, "target_leads": 0, "target_roas": 0 },
  "budget_breakdown": { "meta_ads": 0, "google_ads": 0, "content_creation": 0 }
}`;

        const campaign = await callClaude(prompt, 'strategy', 3000, { businessId: business_id });

        // Save orchestration
        const orchRow = await sbPost('campaign_orchestrations', {
          business_id,
          campaign_name: campaign.campaign_name || 'AI Campaign',
          campaign_theme: campaign.campaign_theme || '',
          campaign_plan: JSON.stringify(campaign),
          status: 'active',
          start_date: new Date().toISOString(),
          end_date: new Date(Date.now() + duration_days * 86400000).toISOString(),
        }).catch(() => null);

        // Execute: generate first batch of content
        const SELF = 'https://maroa-api-production.up.railway.app';
        apiRequest(
          'POST',
          `${SELF}/webhook/instant-content`,
          { 'Content-Type': 'application/json' },
          { business_id }
        ).catch(() => {});

        // Execute: create email sequence if specified
        if (campaign.channels?.email) {
          const emails = [];
          for (let i = 0; i < (campaign.channels.email.emails || 3); i++) {
            emails.push({
              subject_prompt: `Email ${i + 1} for ${campaign.campaign_name}`,
              body_prompt: `${campaign.campaign_theme} - email ${i + 1}`,
              delay_hours: i * 48,
            });
          }
          apiRequest(
            'POST',
            `${SELF}/webhook/email-sequence-create`,
            { 'Content-Type': 'application/json' },
            {
              business_id,
              name: campaign.channels.email.sequence_name || campaign.campaign_name,
              trigger_type: campaign.channels.email.trigger || 'signup',
              emails,
            }
          ).catch(() => {});
        }

        log(
          '/webhook/orchestrate-campaign',
          `✅ Campaign "${campaign.campaign_name}" orchestrated for ${biz.business_name}`
        );
      } catch (err) {
        console.error('[orchestrate-campaign ERROR]', err.message);
        await logError(business_id, 'orchestrate-campaign', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 9: POST /webhook/crisis-check
  // Detects crises: reach drops, negative sentiment, high error rates, wasted spend.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/crisis-check', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Crisis check running' });

    setImmediate(async () => {
      try {
        const [bizArr, thisWeekSnaps, lastWeekSnaps, campaigns, errors, reviews] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=business_name,email,crisis_status`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=7`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&offset=7&limit=7`),
          sbGet('ad_campaigns', `business_id=eq.${business_id}&status=eq.active`),
          sbGet('errors', `business_id=eq.${business_id}&resolved=eq.false`).catch(() => []),
          sbGet('reviews', `business_id=eq.${business_id}&order=created_at.desc&limit=10`).catch(() => []),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
        const thisReach = sum(thisWeekSnaps, 'reach');
        const lastReach = sum(lastWeekSnaps, 'reach');
        const reachDrop = lastReach > 0 ? ((thisReach - lastReach) / lastReach) * 100 : 0;
        const negativeReviews = reviews.filter((r) => (r.rating || 5) <= 2).length;
        const wastedSpend = campaigns.filter((c) => (c.total_spend || 0) > 20 && (c.conversions || 0) === 0);

        const signals = [];
        if (reachDrop < -50)
          signals.push({ type: 'reach_collapse', detail: `Reach dropped ${reachDrop.toFixed(0)}% vs last week` });
        if (negativeReviews >= 3)
          signals.push({ type: 'negative_sentiment', detail: `${negativeReviews} negative reviews recently` });
        if (errors.length >= 5)
          signals.push({ type: 'high_error_rate', detail: `${errors.length} unresolved system errors` });
        if (wastedSpend.length > 0)
          signals.push({ type: 'wasted_spend', detail: `${wastedSpend.length} campaigns spending with 0 conversions` });

        if (!signals.length) {
          await sbPatch('businesses', `id=eq.${business_id}`, { crisis_status: 'healthy' });
          return log('/webhook/crisis-check', `${biz.business_name}: all healthy`);
        }

        // CRISIS DETECTED — Claude Opus responds
        const prompt = `CRISIS DETECTED for ${biz.business_name}.

SIGNALS:
${signals.map((s) => `- [${s.type}] ${s.detail}`).join('\n')}

CURRENT STATE:
- This week reach: ${thisReach} | Last week: ${lastReach} (${reachDrop.toFixed(0)}% change)
- Active campaigns: ${campaigns.length} | Wasted spend campaigns: ${wastedSpend.length}
- System errors: ${errors.length} | Negative reviews: ${negativeReviews}

Diagnose the crisis and create an immediate response plan.
Return ONLY valid JSON:
{
  "crisis_level": "warning" | "critical" | "emergency",
  "diagnosis": "what happened and why",
  "immediate_action": "what to do RIGHT NOW",
  "recovery_plan": [{ "timeframe": "0-6h/6-24h/24-48h", "action": "string" }],
  "campaigns_to_pause": [],
  "emergency_content_needed": true/false,
  "alert_message": "message for business owner"
}`;

        const response = await callClaude(prompt, 'strategy', 1500, { businessId: business_id });

        await sbPatch('businesses', `id=eq.${business_id}`, { crisis_status: response.crisis_level || 'warning' });

        // Pause campaigns if recommended
        if (Array.isArray(response.campaigns_to_pause)) {
          for (const wc of wastedSpend) {
            await sbPatch('ad_campaigns', `id=eq.${wc.id}`, {
              status: 'paused',
              paused_reason: 'Crisis auto-pause: wasted spend',
            }).catch(() => {});
          }
        }

        // Send alert email
        if (biz.email) {
          const html = `<h2>⚠️ Marketing Crisis Detected — ${biz.business_name}</h2>
<p><strong>Level:</strong> ${(response.crisis_level || 'warning').toUpperCase()}</p>
<p><strong>Diagnosis:</strong> ${response.diagnosis || ''}</p>
<p><strong>Immediate action:</strong> ${response.immediate_action || ''}</p>
<h3>Recovery Plan:</h3>
<ul>${(response.recovery_plan || []).map((s) => `<li><strong>${s.timeframe}:</strong> ${s.action}</li>`).join('')}</ul>
<p><a href="https://maroa.ai/dashboard" style="background:#e53e3e;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Dashboard</a></p>`;
          await sendEmail(biz.email, `⚠️ CRISIS: ${response.crisis_level} — ${biz.business_name}`, html).catch(
            () => {}
          );
        }

        // Emergency content if needed
        if (response.emergency_content_needed) {
          apiRequest(
            'POST',
            'https://maroa-api-production.up.railway.app/webhook/instant-content',
            { 'Content-Type': 'application/json' },
            { business_id }
          ).catch(() => {});
        }

        log(
          '/webhook/crisis-check',
          `⚠️ CRISIS ${response.crisis_level} for ${biz.business_name}: ${response.diagnosis}`
        );
      } catch (err) {
        console.error('[crisis-check ERROR]', err.message);
        await logError(business_id, 'crisis-check', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // LEVEL 10: POST /webhook/growth-engine
  // Identifies the single highest leverage growth action every Monday.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/growth-engine', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(business_id)) return res.status(400).json({ error: 'business_id must be a valid UUID' });

    res.json({ received: true, message: 'Growth engine analyzing highest leverage action' });

    setImmediate(async () => {
      try {
        const [bizArr, snapshots, campaigns, contacts, revenue, content] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=*`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=30`),
          sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status,daily_budget,roas,total_spend`),
          sbGet('contacts', `business_id=eq.${business_id}&select=id,lead_score,intent_level`),
          sbGet('revenue_attribution', `business_id=eq.${business_id}&select=amount,source`).catch(() => []),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&order=created_at.desc&limit=10&select=status,performance_score`
          ),
        ]);
        const biz = bizArr[0];
        if (!biz) return;

        const totalReach = snapshots.reduce((s, r) => s + (r.reach || 0), 0);
        const totalRevenue = revenue.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const activeCamps = campaigns.filter((c) => c.status === 'active').length;
        const hotLeads = contacts.filter((c) => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
        const avgContent =
          content.length > 0
            ? (content.reduce((s, c) => s + (c.performance_score || 0), 0) / content.length).toFixed(1)
            : '0';

        const prompt = `You are a growth strategist for ${biz.business_name} (${biz.industry || 'business'}).
Plan: ${biz.plan || 'free'} | Goal: ${biz.marketing_goal || 'grow'}

CURRENT METRICS (30 days):
- Total reach: ${totalReach} | Revenue: $${totalRevenue.toFixed(2)}
- Active campaigns: ${activeCamps} | Hot leads: ${hotLeads}
- Total contacts: ${contacts.length} | Avg content score: ${avgContent}/10
- Ad spend: $${campaigns.reduce((s, c) => s + (c.total_spend || 0), 0).toFixed(2)}

Evaluate ALL growth levers. Score each: (potential_impact * feasibility / cost)

LEVERS TO EVALUATE:
1. Increase posting frequency (more content → more reach)
2. Boost ad budget (more spend → more leads)
3. Launch new platform (LinkedIn/TikTok → new audience)
4. Start review collection campaign (social proof → trust)
5. Create lead magnet (free resource → email list growth)
6. Run referral campaign (existing customers → viral growth)
7. Partner with complementary business (cross-promotion)

Pick THE SINGLE HIGHEST LEVERAGE action. Be specific.
Return ONLY valid JSON:
{
  "growth_levers": [
    { "lever": "string", "impact_score": 1-10, "feasibility": 1-10, "cost": 1-10, "final_score": 0, "why": "string" }
  ],
  "recommended_action": {
    "lever": "the winning lever",
    "specific_plan": "exact steps to execute this week",
    "expected_outcome": "what will happen",
    "kpi_to_track": "what metric to watch",
    "timeline": "when to expect results"
  },
  "growth_trajectory": "where the business is headed",
  "bottleneck": "the #1 thing holding growth back"
}`;

        const result = await callClaude(prompt, 'strategy', 2000, { businessId: business_id });

        await sbPatch('businesses', `id=eq.${business_id}`, {
          growth_engine_recommendation: JSON.stringify(result),
          ai_brain_decisions: JSON.stringify({
            ...(() => {
              try {
                return JSON.parse(biz.ai_brain_decisions || '{}');
              } catch {
                return {};
              }
            })(),
            growth_engine: result.recommended_action,
          }),
          strategy_updated_at: new Date().toISOString(),
        });

        try {
          storeInsight(business_id, 'growth', 'growth_strategy', 'top_lever', result.recommended_action?.lever || '');
          storeInsight(business_id, 'growth', 'growth_strategy', 'bottleneck', result.bottleneck || '');
        } catch {
          /* soft-fail */
        }
        log('/webhook/growth-engine', `✅ Growth engine: ${result.recommended_action?.lever} for ${biz.business_name}`);
      } catch (err) {
        console.error('[growth-engine ERROR]', err.message);
        await logError(business_id, 'growth-engine', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/auto-approve-content — FIX 1
  // Scores all pending content, auto-approves score>=7, sends review for 5-6,
  // regenerates <5. Returns counts.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/auto-approve-content', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
      const [bizArr, pending] = await Promise.all([
        sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,email,facebook_page_id,meta_access_token,instagram_account_id,linkedin_access_token,autopilot_enabled`
        ),
        sbGet(
          'generated_content',
          `business_id=eq.${business_id}&status=eq.pending_approval&order=created_at.desc&limit=50&select=id,instagram_caption,facebook_post,content_theme,strategy_reason`
        ),
      ]);
      const biz = bizArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      if (!pending.length)
        return res.json({ approved: 0, sent_for_review: 0, regenerated: 0, message: 'No pending content' });

      let approved = 0,
        sent_for_review = 0,
        regenerated = 0;

      for (const piece of pending) {
        try {
          const caption = piece.instagram_caption || piece.facebook_post || '';
          if (!caption) {
            regenerated++;
            continue;
          }

          // Score internally via callClaude (faster than HTTP round-trip)
          const scorePrompt = `Rate this social media caption 1-10 for a ${biz.business_name || 'business'}. Consider brand voice, engagement potential, uniqueness, audience relevance. Caption: "${caption.slice(0, 500)}" Return ONLY valid JSON: {"score":1-10}`;
          const scoreResult = await callClaude(scorePrompt, 'caption', 200);
          const score = scoreResult.score || 0;

          if (score >= 7) {
            await sbPatch('generated_content', `id=eq.${piece.id}`, {
              status: 'approved',
              approved_at: new Date().toISOString(),
              approval_method: 'auto_ai',
              pre_post_score: score,
            });
            approved++;
          } else if (score >= 5) {
            // Send for human review
            if (biz.email) {
              await sendEmail(
                biz.email,
                `Content needs your review — ${piece.content_theme || 'new post'}`,
                `<h2>Quick Review Needed</h2><p>AI scored this <strong>${score}/10</strong>:</p><blockquote>${caption.slice(0, 300)}</blockquote><p><a href="https://maroa.ai/content" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve</a></p>`
              ).catch(() => {});
            }
            sent_for_review++;
          } else {
            // Auto-regenerate
            await sbPatch('generated_content', `id=eq.${piece.id}`, { status: 'rejected' });
            regenerated++;
          }
        } catch (e) {
          log('/webhook/auto-approve-content', `Piece ${piece.id} error: ${e.message}`);
        }
      }

      // Trigger regeneration if any were rejected
      if (regenerated > 0) {
        apiRequest(
          'POST',
          'https://maroa-api-production.up.railway.app/webhook/instant-content',
          { 'Content-Type': 'application/json' },
          { business_id, email: biz.email }
        ).catch(() => {});
      }

      res.json({ approved, sent_for_review, regenerated, total: pending.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/publish-approved-content — FIX 8
  // Publishes all approved-but-unpublished content to connected platforms.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/publish-approved-content', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
      const [bizArr, approved] = await Promise.all([
        sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,meta_access_token,facebook_page_id,instagram_account_id,linkedin_access_token,linkedin_person_id,autopilot_enabled,posts_published`
        ),
        sbGet(
          'generated_content',
          `business_id=eq.${business_id}&status=eq.approved&published_at=is.null&order=created_at.asc&limit=10&select=id,instagram_caption,facebook_post,image_url,content_theme,strategy_reason`
        ),
      ]);
      const biz = bizArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      if (!approved.length)
        return res.json({ published: 0, failed: 0, platforms: [], message: 'No approved content to publish' });

      let published = 0,
        failed = 0;
      const allPlatforms = new Set();

      for (const piece of approved) {
        const platforms = [];
        try {
          // Facebook
          if (biz.meta_access_token && biz.facebook_page_id) {
            try {
              const fbResp = await externalHttp(
                apiRequest,
                'POST',
                `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/feed`,
                { 'Content-Type': 'application/json' },
                {
                  message: piece.facebook_post || piece.instagram_caption,
                  access_token: biz.meta_access_token,
                  ...(piece.image_url ? { link: piece.image_url } : {}),
                }
              );
              if (fbResp.body?.id) platforms.push('facebook');
            } catch {
              /* soft-fail */
            }
          }

          // Instagram
          if (biz.meta_access_token && biz.instagram_account_id && piece.image_url) {
            try {
              const step1 = await externalHttp(
                apiRequest,
                'POST',
                `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media`,
                { 'Content-Type': 'application/json' },
                { image_url: piece.image_url, caption: piece.instagram_caption, access_token: biz.meta_access_token }
              );
              if (step1.body?.id) {
                const step2 = await externalHttp(
                  apiRequest,
                  'POST',
                  `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media_publish`,
                  { 'Content-Type': 'application/json' },
                  { creation_id: step1.body.id, access_token: biz.meta_access_token }
                );
                if (step2.body?.id) platforms.push('instagram');
              }
            } catch {
              /* soft-fail */
            }
          }

          // LinkedIn
          if (biz.linkedin_access_token && biz.linkedin_person_id) {
            try {
              const authorUrn = `urn:li:person:${biz.linkedin_person_id}`;
              const ugc = {
                author: authorUrn,
                lifecycleState: 'PUBLISHED',
                specificContent: {
                  'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text: piece.instagram_caption || piece.facebook_post },
                    shareMediaCategory: 'NONE',
                  },
                },
                visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
              };
              const liResp = await apiRequest(
                'POST',
                'https://api.linkedin.com/v2/ugcPosts',
                {
                  Authorization: `Bearer ${biz.linkedin_access_token}`,
                  'Content-Type': 'application/json',
                  'X-Restli-Protocol-Version': '2.0.0',
                },
                ugc
              );
              if (liResp.body?.id) platforms.push('linkedin');
            } catch {
              /* soft-fail */
            }
          }

          if (platforms.length > 0) {
            await sbPatch('generated_content', `id=eq.${piece.id}`, {
              status: 'published',
              published_at: new Date().toISOString(),
            });
            platforms.forEach((p) => allPlatforms.add(p));
            published++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }

      // Update posts_published count
      if (published > 0) {
        await sbPatch('businesses', `id=eq.${business_id}`, {
          posts_published: (biz.posts_published || 0) + published,
        }).catch(() => {});
      }

      res.json({ published, failed, platforms: [...allPlatforms], total: approved.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/generate-image — On-demand image generation API
  // Body: { business_id, prompt, content_type? }
  // ─────────────────────────────────────────────────────────────────────────────
  // Shared per-plan generation quota helper for the direct generation webhooks
  // (/webhook/generate-image, /webhook/video-generate). /api/generate enforces
  // this via checkPlanLimit middleware + writes usage_logs; these webhooks
  // bypassed both, so a customer could exceed their plan's image/video quota by
  // calling the webhook directly. business_id is the usage key (matches the
  // planLimits convention where "user_id" == the business id).
  async function _checkGenQuota(businessId, action) {
    try {
      const bizArr = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=plan`).catch(() => []);
      const plan = normalizePlan(bizArr[0]?.plan);
      const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;
      const key =
        action === 'generate_image'
          ? 'images'
          : action === 'generate_video_kling'
            ? 'kling'
            : action === 'generate_video_sora'
              ? 'sora'
              : null;
      if (!key) return { allowed: true, plan };
      const cap = Number(limits[key] || 0);
      if (cap <= 0) return { allowed: false, plan, limit: cap, used: 0, key };
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const rows = await sbGet(
        'usage_logs',
        `user_id=eq.${encodeURIComponent(businessId)}&action=eq.${encodeURIComponent(action)}&created_at=gte.${encodeURIComponent(monthStart.toISOString())}&select=id&limit=${cap + 1}`
      ).catch(() => []);
      const used = Array.isArray(rows) ? rows.length : 0;
      return { allowed: used < cap, plan, limit: cap, used, key };
    } catch {
      return { allowed: true }; // soft-fail: never block generation on a telemetry error
    }
  }
  async function _logGenUsage(businessId, action) {
    await sbPost('usage_logs', { user_id: businessId, action, created_at: new Date().toISOString() }).catch(() => {});
  }

  app.post('/webhook/generate-image', async (req, res) => {
    const { business_id, prompt, content_type = 'social_post' } = req.body;
    if (!business_id || !prompt) return res.status(400).json({ error: 'business_id and prompt required' });

    // Return immediately — generation happens async (Flux can take 30-60s)
    res.json({ received: true, message: 'Image generation started — result saved to business_photos' });

    setImmediate(async () => {
      try {
        const quota = await _checkGenQuota(business_id, 'generate_image');
        if (!quota.allowed) {
          log('/webhook/generate-image', `quota reached for ${business_id} (${quota.used}/${quota.limit})`);
          return;
        }
        const bizArr = await sbGet('businesses', `id=eq.${encodeURIComponent(business_id)}&select=plan`);
        const plan = bizArr[0]?.plan || 'free';
        const result = await generateSmartImage(business_id, prompt, content_type, plan);
        await _logGenUsage(business_id, 'generate_image');
        if (result.url) {
          await sbPost('business_photos', {
            business_id,
            photo_url: result.url,
            photo_type: content_type,
            description: prompt.slice(0, 200),
            is_active: true,
          }).catch(() => {});
          try {
            storeInsight(business_id, 'images', 'visual_strategy', 'image_model', result.model_used || 'unknown');
          } catch {
            /* soft-fail */
          }
          log('/webhook/generate-image', `✅ ${result.model_used}: ${result.url}`);
        }
      } catch (err) {
        console.error('[generate-image ERROR]', err.message);
        await logError(business_id, 'generate-image', err.message).catch(() => {});
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/score-image — Claude Vision rates an image 1-10
  // Body: { business_id, image_url, content_type? }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/score-image', async (req, res) => {
    const { business_id, image_url, content_type = 'social_post' } = req.body;
    if (!business_id || !image_url) return res.status(400).json({ error: 'business_id and image_url required' });
    try {
      // 2026-05-13 audit P2: route through callClaude so cost-tracking,
      // retries, and budget gates apply. Image block goes via extra.imageBlocks.
      const raw = await callClaude(
        `Score this marketing image for a ${content_type} post. Rate 1-10 on: professional quality, visual appeal, marketing effectiveness. Return ONLY valid JSON: {"overall_score":1-10,"recommendation":"use"|"regenerate"|"reject","feedback":"one sentence"}`,
        'claude-sonnet-4-5',
        300,
        {
          businessId: business_id,
          skill: 'score_image',
          imageBlocks: [{ type: 'image', source: { type: 'url', url: image_url } }],
          returnRaw: true,
        }
      );
      const parsed = extractJSON(raw) || { overall_score: 5, recommendation: 'use', feedback: 'Could not parse score' };
      res.json(parsed);
    } catch (err) {
      // Budget-exceeded errors get a 402 propagated; everything else falls back.
      if (err && err.status === 402) {
        return res.status(402).json({ error: err.code || 'AI_BUDGET_EXCEEDED', message: err.message });
      }
      res.status(500).json({ overall_score: 5, recommendation: 'use', feedback: 'Image scoring failed' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/inject-marketing-skills — Inject 15 expert frameworks into Pinecone
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/api/inject-marketing-skills', requireAdminSecret, async (req, res) => {
    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST)
      return res.status(400).json({ error: 'OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST required' });
    res.json({ received: true, message: 'Injecting 15 marketing skill frameworks into Pinecone — takes ~2 minutes' });
    setImmediate(async () => {
      try {
        const { injectAllSkills } = require('./services/marketingKnowledgeBase');
        await injectAllSkills(getEmbedding, pineconeUpsert);
        log('/api/inject-marketing-skills', '✅ All 15 marketing skills injected');
      } catch (err) {
        console.error('[inject-marketing-skills ERROR]', err.message);
      }
    });
  });

  // Short alias: /webhook/score-content → /webhook/score-content-before-posting
  app.post('/webhook/score-content', (req, res) => {
    req.url = '/webhook/score-content-before-posting';
    app.handle(req, res);
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // GET /webhook/errors-get?business_id=X — view recent errors for debugging
  app.get('/webhook/errors-get', requireAdminSecret, async (req, res) => {
    const { business_id, workflow_name, limit: lim = 10 } = req.query;
    try {
      let filter = `order=created_at.desc&limit=${lim}&select=id,business_id,workflow_name,error_message,created_at,resolved`;
      if (business_id) filter += `&business_id=eq.${business_id}`;
      if (workflow_name) filter += `&workflow_name=eq.${workflow_name}`;
      const errors = await sbGet('errors', filter);
      res.json({ errors, count: errors.length });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch errors' });
    }
  });

  // FINAL COMPLETE PLATFORM — Missing Pieces 2-15
  // ═════════════════════════════════════════════════════════════════════════════

  // ── PIECE 2: WhatsApp Notifications ─────────────────────────────────────────
  app.post('/webhook/whatsapp-send', async (req, res) => {
    const { business_id, message } = req.body;
    if (!business_id || !message) return res.status(400).json({ error: 'business_id and message required' });
    try {
      const biz = (
        await sbGet('businesses', `id=eq.${business_id}&select=whatsapp_number,whatsapp_enabled,business_name`)
      )[0];
      if (!biz?.whatsapp_number || !biz.whatsapp_enabled)
        return res.json({ sent: false, reason: 'WhatsApp not configured' });
      const result = await sendWhatsApp(biz.whatsapp_number, message);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/whatsapp-test', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const biz = (
        await sbGet('businesses', `id=eq.${business_id}&select=whatsapp_number,whatsapp_enabled,business_name`)
      )[0];
      if (!biz?.whatsapp_number)
        return res.json({ sent: false, reason: 'No whatsapp_number set — add it in Settings' });
      if (!TWILIO_ACCOUNT_SID)
        return res.json({ sent: false, reason: 'Twilio not configured — set TWILIO_ACCOUNT_SID in Railway' });
      const msg = `✅ *maroa.ai WhatsApp Connected!*\n\nHi! This is your AI marketing assistant for ${biz.business_name}.\n\nYou'll receive:\n📊 Weekly performance digests\n🔥 Hot lead alerts\n🚀 Viral content notifications\n⚡ Competitor alerts\n\nYour AI is always working. 🤖`;
      const result = await sendWhatsApp(biz.whatsapp_number, msg);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/whatsapp-weekly-digest', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'Weekly digest being sent' });
    setImmediate(async () => {
      try {
        const biz = (
          await sbGet(
            'businesses',
            `id=eq.${business_id}&select=business_name,whatsapp_number,whatsapp_enabled,ai_brain_decisions,posts_published`
          )
        )[0];
        if (!biz?.whatsapp_number || !biz.whatsapp_enabled) return;
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const [contacts, content] = await Promise.all([
          sbGet('contacts', `business_id=eq.${business_id}&created_at=gte.${weekAgo}&select=id`),
          sbGet(
            'generated_content',
            `business_id=eq.${business_id}&created_at=gte.${weekAgo}&status=eq.published&select=content_theme,performance_score`
          ),
        ]);
        const bestTheme =
          content.sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0))[0]?.content_theme ||
          'various topics';
        let brain = {};
        try {
          brain = JSON.parse(biz.ai_brain_decisions || '{}');
        } catch {
          /* soft-fail */
        }
        const msg = `📊 *Your AI Marketing Week — ${biz.business_name}*\n\n✅ Posts published: ${content.length}\n👥 New leads: ${contacts.length}\n🎯 Best post: ${bestTheme}\n💡 Focus: ${brain.content_strategy || brain.highest_leverage_action?.what || 'growing your brand'}\n\nYour AI is running. Nothing to do. 🤖`;
        await sendWhatsApp(biz.whatsapp_number, msg);
      } catch (err) {
        console.error('[whatsapp-digest ERROR]', err.message);
      }
    });
  });

  // ── PIECE 3: One-Tap Email Approvals ────────────────────────────────────────
  app.get('/webhook/email-approve', async (req, res) => {
    const { token, action } = req.query;
    if (!token || !action) return res.status(400).send('<h1>Invalid link</h1>');
    // token is interpolated into a PostgREST filter and this route is
    // unauthenticated (OPEN_PATHS) — constrain to an opaque-token charset so an
    // attacker can't inject extra `&`-delimited filters, and gate the action.
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(token)) {
      return res.status(400).send('<h1>Invalid link</h1>');
    }
    if (!['approve', 'reject', 'regenerate'].includes(action)) {
      return res.status(400).send('<h1>Invalid link</h1>');
    }
    try {
      const rows = await sbGet('content_approvals', `token=eq.${encodeURIComponent(token)}&used_at=is.null&select=*`);
      const approval = rows[0];
      if (!approval)
        return res.send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Link expired or already used</h1></body></html>'
        );
      if (new Date(approval.expires_at) < new Date())
        return res.send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Link expired</h1></body></html>'
        );
      await sbPatch('content_approvals', `id=eq.${approval.id}`, { action, used_at: new Date().toISOString() });
      if (action === 'approve') {
        await sbPatch('generated_content', `id=eq.${approval.content_id}`, {
          status: 'approved',
          approved_at: new Date().toISOString(),
          approval_method: 'email_one_tap',
        });
        apiRequest(
          'POST',
          `https://maroa-api-production.up.railway.app/webhook/publish-approved-content`,
          { 'Content-Type': 'application/json' },
          { business_id: approval.business_id }
        ).catch(() => {});
        sendSSE(approval.business_id, 'content_approved', { content_id: approval.content_id });
        return res.send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">✅ Content Approved!</h1><p>It will publish at your optimal posting time.</p></body></html>'
        );
      } else if (action === 'reject') {
        await sbPatch('generated_content', `id=eq.${approval.content_id}`, { status: 'rejected' });
        return res.send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fef2f2"><h1 style="color:#dc2626">❌ Content Rejected</h1><p>Your AI will generate better content.</p></body></html>'
        );
      } else if (action === 'regenerate') {
        await sbPatch('generated_content', `id=eq.${approval.content_id}`, { status: 'rejected' });
        apiRequest(
          'POST',
          `https://maroa-api-production.up.railway.app/webhook/instant-content`,
          { 'Content-Type': 'application/json' },
          { business_id: approval.business_id }
        ).catch(() => {});
        return res.send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fffbeb"><h1 style="color:#d97706">🔄 Regenerating</h1><p>New content will be ready in ~2 minutes.</p></body></html>'
        );
      }
      res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Done</h1></body></html>');
    } catch (err) {
      log?.('/webhook/email-approve', `error: ${err.message}`);
      res
        .status(500)
        .send(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Something went wrong</h1><p>Please try again from your dashboard.</p></body></html>'
        );
    }
  });

  // ── PIECE 4: Real-Time Dashboard Events (SSE) ──────────────────────────────
  app.get('/webhook/dashboard-events', async (req, res) => {
    // 'stream-ticket' = short-lived signed ticket from POST /api/stream-ticket
    // (EventSource cannot send an Authorization header). The webhook-secret
    // machine path stays excluded — it carries no user to scope events to.
    if ((req.authSource !== 'jwt' && req.authSource !== 'stream-ticket') || !req.user) {
      return apiError(res, 401, 'UNAUTHORIZED', 'JWT or stream ticket required for dashboard events');
    }
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    const { assertBusinessOwner } = require('./lib/assertBusinessOwner');
    if (!(await assertBusinessOwner(req, res, business_id, { sbGet, apiError, logger }))) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const allowedOrigins = [
      'https://maroa.ai',
      'https://www.maroa.ai',
      'https://maroa-ai-marketing-automator.lovable.app',
      'https://maroa-ai-marketing-automator.vercel.app',
      'http://localhost:5173',
      'http://localhost:3000',
    ];
    const reqOrigin = req.headers.origin;
    // Also allow any *.vercel.app preview deployment
    const isVercelPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(reqOrigin || '');
    if (reqOrigin && (allowedOrigins.includes(reqOrigin) || isVercelPreview)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.write(`data: ${JSON.stringify({ type: 'connected', business_id })}\n\n`);
    sseClients.set(business_id, res);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }, 30000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(business_id);
    });
  });

  // ── PIECE 5: Paddle Webhook Handler — route registered at top (raw body); handler hoisted below ──
  // Maps Paddle price IDs to plan names
  const PADDLE_PRICE_TO_PLAN = {};
  if (PADDLE_STARTER_PRICE) PADDLE_PRICE_TO_PLAN[PADDLE_STARTER_PRICE] = 'starter';
  if (PADDLE_GROWTH_PRICE) PADDLE_PRICE_TO_PLAN[PADDLE_GROWTH_PRICE] = 'growth';
  if (PADDLE_AGENCY_PRICE) PADDLE_PRICE_TO_PLAN[PADDLE_AGENCY_PRICE] = 'agency';

  async function paddleWebhookHandler(req, res) {
    if (!PADDLE_WEBHOOK_SECRET) {
      return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'PADDLE_WEBHOOK_SECRET not configured');
    }
    const sig = req.headers['paddle-signature'];
    const rawBody = req.body;
    if (!sig || !Buffer.isBuffer(rawBody)) {
      return apiError(res, 400, 'INVALID_REQUEST', 'Missing Paddle signature or raw body');
    }
    const valid = paddle.verifyWebhookSignature(rawBody.toString(), sig, PADDLE_WEBHOOK_SECRET);
    if (!valid) {
      logger.warn('/webhook/paddle-webhook', null, 'Paddle signature/timestamp verification failed', {
        request_id: req.requestId,
      });
      return apiError(res, 400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString());
    } catch {
      return apiError(res, 400, 'INVALID_JSON', 'Could not parse webhook body');
    }

    // Idempotency: Paddle can deliver the same notification twice. Block
    // duplicates before any side-effect (plan grant, cold-start fire, email).
    const eventId = event?.notification_id || event?.event_id || event?.data?.id;
    const _wh = require('./lib/webhookEvents');
    if (eventId) {
      const dedup = await _wh.markProcessed({ provider: 'paddle', eventId, sbPost, sbPatch, sbGet, logger });
      if (!dedup.firstTime) {
        logger.info('/webhook/paddle-webhook', null, 'duplicate event — skipping', { event_id: eventId });
        return res.json({ received: true, duplicate: true });
      }
    }

    // Provision SYNCHRONOUSLY, then ACK based on outcome in `finally` (so the
    // early no-op `return` still ACKs 200). On failure we commit the event
    // 'failed', evict the LRU, and return 500 so Paddle retries — instead of the
    // old ACK-200-before-grant which left paid customers permanently un-provisioned.
    let _paddleOk = true;
    let _paddleErr = null;
    try {
      const eventType = event?.event_type;
      const data = event?.data;
      if (!eventType || !data) return;

      if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
        const customData = data.custom_data || {};
        const businessId = customData.business_id;
        const priceId = data.items?.[0]?.price?.id;
        const plan = customData.plan || PADDLE_PRICE_TO_PLAN[priceId] || 'starter';
        if (businessId) {
          // Check the PRIOR plan so we know if this is "first activation" vs renewal
          const priorRows = await sbGet('businesses', `id=eq.${businessId}&select=plan,onboarding_state`).catch(
            () => []
          );
          const priorPlan = priorRows?.[0]?.plan || 'free';
          const wasOnFreeOrUnpaid = priorPlan === 'free' || priorPlan === 'starter' || !priorPlan;
          const isNowPaid = plan === 'growth' || plan === 'agency';

          await sbPatch('businesses', `id=eq.${businessId}`, {
            plan,
            paddle_customer_id: data.customer_id,
            paddle_subscription_id: data.id,
          });
          const biz = (
            await sbGet('businesses', `id=eq.${businessId}&select=email,business_name,whatsapp_number,whatsapp_enabled`)
          )[0];
          if (biz?.email)
            await sendEmail(
              biz.email,
              `Welcome to ${plan} plan! — ${biz.business_name}`,
              `<h2>You're now on the ${plan} plan!</h2><p>Your AI just unlocked: ${plan === 'agency' ? 'white-label, multi-workspace, priority support' : 'ad campaigns, competitor intel, advanced analytics'}.</p>`
            ).catch(() => {});
          if (biz?.whatsapp_number && biz.whatsapp_enabled)
            sendWhatsApp(biz.whatsapp_number, `*Upgraded to ${plan}!* Your AI just unlocked new features.`).catch(
              () => {}
            );
          sendSSE(businessId, 'plan_upgraded', { plan });

          // ─── Auto-trigger cold-start onboarding (FIRST paid activation only) ──
          // Fires the cold-start orchestrator the moment a customer goes from
          // free/unpaid → growth/agency. Idempotent — cold-start has its own
          // (business_id, run_date) unique constraint so duplicate webhooks
          // don't create duplicate runs.
          if (wasOnFreeOrUnpaid && isNowPaid) {
            try {
              const internalSecret = process.env.N8N_WEBHOOK_SECRET || '';
              // Fire-and-forget to our own cold-start endpoint over localhost.
              // Don't await its full chain (some phases take ~minutes) — just
              // kick off and return.
              fetch(`http://127.0.0.1:${process.env.PORT || 3000}/webhook/cold-start-trigger`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(internalSecret ? { 'x-webhook-secret': internalSecret } : {}),
                },
                body: JSON.stringify({ businessId, source: 'paddle_subscription_activated', plan }),
              }).catch((e) =>
                logger.warn('/paddle/webhook', businessId, 'cold-start auto-trigger failed', { error: e.message })
              );
              logger.info('/paddle/webhook', businessId, 'cold-start auto-triggered on first paid activation', {
                plan,
                priorPlan,
              });
              await sbPost?.('onboarding_events', {
                business_id: businessId,
                event_type: 'cold_start_auto_triggered',
                event_data: { source: 'paddle', plan, prior_plan: priorPlan, subscription_id: data.id },
              }).catch(() => {});
            } catch (autoTriggerErr) {
              logger.warn('/paddle/webhook', businessId, 'cold-start auto-trigger threw', {
                error: autoTriggerErr.message,
              });
            }
          }
        }
      } else if (eventType === 'subscription.canceled') {
        // Also set is_active:false so the 16 background crons (which select
        // is_active=eq.true) stop processing — otherwise a churned account
        // keeps incurring LLM/image/email cost at $0 revenue indefinitely.
        const canceledPatch = { plan: 'free', plan_price: 0, is_active: false };
        const businessId = data.custom_data?.business_id;
        if (businessId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, canceledPatch);
        } else {
          const bizArr = await sbGet(
            'businesses',
            `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`
          );
          if (bizArr[0]) await sbPatch('businesses', `id=eq.${encodeURIComponent(bizArr[0].id)}`, canceledPatch);
        }
      } else if (eventType === 'subscription.past_due' || eventType === 'transaction.payment_failed') {
        // Payment failed — downgrade to free
        const failBizId = data.custom_data?.business_id;
        if (failBizId) {
          await sbPatch('businesses', `id=eq.${failBizId}`, { plan: 'free', plan_price: 0 });
          logger.warn('/paddle/webhook', failBizId, 'Payment failed — downgraded to free', { event_type: eventType });
        } else if (data.subscription_id || data.id) {
          // Fallback: find by subscription ID
          const subId = data.subscription_id || data.id;
          const bizArr = await sbGet('businesses', `paddle_subscription_id=eq.${subId}&select=id`);
          if (bizArr[0]) {
            await sbPatch('businesses', `id=eq.${bizArr[0].id}`, { plan: 'free', plan_price: 0 });
            logger.warn('/paddle/webhook', bizArr[0].id, 'Payment failed — downgraded to free (by sub ID)', {
              event_type: eventType,
            });
          }
        }
      } else if (eventType === 'transaction.completed') {
        const customData = data.custom_data || {};
        if (customData.business_id) {
          await sbPost('usage_logs', {
            user_id: customData.business_id,
            action: 'paddle_transaction',
            plan_name: customData.plan || 'unknown',
            model_used: 'paddle',
            credits_used: 0,
            status: 'success',
          }).catch(() => {});
        }
      } else if (eventType === 'subscription.paused') {
        // Customer paused (Paddle's pause feature). Keep their plan tier
        // but flag billing as paused so the cost guard's plan-tier lookup
        // can fall back to a stricter cap if desired.
        const pausedBizId = data.custom_data?.business_id;
        const bizId =
          pausedBizId ||
          (
            await sbGet('businesses', `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`).catch(
              () => []
            )
          )[0]?.id;
        if (bizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
            paddle_subscription_status: 'paused',
          }).catch(() => {});
          logger.info('/paddle/webhook', bizId, 'subscription paused', { event_type: eventType });
        }
      } else if (eventType === 'subscription.resumed') {
        // Resumed after pause — restore plan tier to whatever's on the
        // subscription items (Paddle includes price_id in data.items).
        const resumedBizId = data.custom_data?.business_id;
        const priceId = data.items?.[0]?.price?.id;
        const restoredPlan = data.custom_data?.plan || PADDLE_PRICE_TO_PLAN[priceId] || 'starter';
        const bizId =
          resumedBizId ||
          (
            await sbGet('businesses', `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`).catch(
              () => []
            )
          )[0]?.id;
        if (bizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
            plan: restoredPlan,
            paddle_subscription_status: 'active',
          }).catch(() => {});
          logger.info('/paddle/webhook', bizId, 'subscription resumed', { event_type: eventType, plan: restoredPlan });
        }
      } else if (eventType === 'adjustment.created' || eventType === 'transaction.refunded') {
        // Refund issued. We log it for accounting + downgrade if a full
        // refund (action='refund' with no remaining items). Partial refunds
        // (credit notes) keep the plan but flag the audit log.
        const refundBizId = data.custom_data?.business_id;
        const isFullRefund =
          data.action === 'refund' && !data.items?.some?.((i) => Number(i.totals?.subtotal || 0) > 0);
        const bizId =
          refundBizId ||
          (data.subscription_id
            ? (
                await sbGet(
                  'businesses',
                  `paddle_subscription_id=eq.${encodeURIComponent(data.subscription_id)}&select=id`
                ).catch(() => [])
              )[0]?.id
            : null);
        if (bizId) {
          await sbPost('usage_logs', {
            user_id: bizId,
            action: 'paddle_refund',
            plan_name: data.custom_data?.plan || 'unknown',
            model_used: 'paddle',
            credits_used: 0,
            status: 'refunded',
          }).catch(() => {});
          if (isFullRefund) {
            await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
              plan: 'free',
              plan_price: 0,
              paddle_subscription_status: 'refunded',
            }).catch(() => {});
            logger.warn('/paddle/webhook', bizId, 'full refund — downgraded to free', { event_type: eventType });
          } else {
            logger.info('/paddle/webhook', bizId, 'partial refund logged', { event_type: eventType });
          }
        }
      } else if (eventType === 'subscription.trialing') {
        // Trial activation — same plan grant as activated but flag the
        // status so we can show "trial ends Mar 18" in the dashboard.
        const trialBizId = data.custom_data?.business_id;
        const trialPlan = data.custom_data?.plan || PADDLE_PRICE_TO_PLAN[data.items?.[0]?.price?.id] || 'starter';
        if (trialBizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(trialBizId)}`, {
            plan: trialPlan,
            paddle_subscription_status: 'trialing',
            trial_ends_at: data.current_billing_period?.ends_at || null,
          }).catch(() => {});
        }
      } else {
        // Unhandled event type — log for observability so we know what
        // Paddle is sending. Add a handler above when we want to act on it.
        logger.info('/paddle/webhook', null, 'unhandled paddle event type', { event_type: eventType });
      }
    } catch (err) {
      console.error('[paddle-webhook ERROR]', err.message);
      logger.error('/paddle/webhook', null, 'handler crashed', err);
      _paddleOk = false;
      _paddleErr = err.message;
    } finally {
      if (eventId) {
        await _wh
          .commitProcessed({
            provider: 'paddle',
            eventId,
            status: _paddleOk ? 'processed' : 'failed',
            sbPatch,
            logger,
            error: _paddleOk ? null : _paddleErr,
          })
          .catch(() => {});
        if (!_paddleOk) _wh.forgetEvent('paddle', eventId);
      }
      if (!res.headersSent) {
        if (_paddleOk) res.json({ received: true });
        else res.status(500).json({ error: { code: 'HANDLER_ERROR', message: 'event processing error' } });
      }
    }
  }

  _paddleWebhookHandler = paddleWebhookHandler;

  // ── PIECE 6: Google My Business Auto-Post ───────────────────────────────────
  app.post('/webhook/gmb-post', async (req, res) => {
    const { business_id, content_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const biz = (
        await sbGet('businesses', `id=eq.${business_id}&select=gmb_access_token,gmb_location_id,website_url`)
      )[0];
      if (!biz?.gmb_access_token || !biz?.gmb_location_id)
        return res.json({ posted: false, reason: 'GMB not connected' });
      let caption = '';
      if (content_id) {
        const cont = (
          await sbGet('generated_content', `id=eq.${content_id}&select=facebook_post,instagram_caption,image_url`)
        )[0];
        caption = cont?.facebook_post || cont?.instagram_caption || '';
      }
      if (!caption) return res.json({ posted: false, reason: 'No content to post' });
      const gmbResp = await apiRequest(
        'POST',
        `https://mybusiness.googleapis.com/v4/${biz.gmb_location_id}/localPosts`,
        { Authorization: `Bearer ${biz.gmb_access_token}`, 'Content-Type': 'application/json' },
        {
          languageCode: 'en-US',
          summary: caption.slice(0, 1500),
          topicType: 'STANDARD',
          callToAction: { actionType: 'LEARN_MORE', url: biz.website_url || '' },
        }
      );
      if (gmbResp.body?.name) {
        if (content_id)
          await sbPatch('generated_content', `id=eq.${content_id}`, { gmb_post_id: gmbResp.body.name }).catch(() => {});
        return res.json({ posted: true, post_id: gmbResp.body.name });
      }
      res.status(502).json({ posted: false, error: 'Service temporarily unavailable' });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });

  // ── PIECE 7: AI Video Generation (Runway) ───────────────────────────────────
  app.post('/webhook/video-generate', async (req, res) => {
    const { business_id, video_id } = req.body;
    if (!business_id || !video_id) return res.status(400).json({ error: 'business_id and video_id required' });
    if (!isUUID(String(business_id)) || !isUUID(String(video_id)))
      return res.status(400).json({ error: 'business_id and video_id must be valid UUIDs' });
    if (!RUNWAY_API_KEY) return res.json({ generated: false, reason: 'RUNWAY_API_KEY not set' });
    res.json({ received: true, message: 'Video generation started — this takes 2-5 minutes' });
    setImmediate(async () => {
      try {
        // Per-plan video quota (paid video gen) — was ungated, letting a plan
        // exceed its video allowance by calling this webhook directly.
        const quota = await _checkGenQuota(business_id, 'generate_video_kling');
        if (!quota.allowed) {
          log('/webhook/video-generate', `video quota reached for ${business_id} (${quota.used}/${quota.limit})`);
          return;
        }
        log('/webhook/video-generate', `Starting for video ${video_id}`);
        // Scope by business_id so a caller can't drive generation on another
        // tenant's video row (IDOR); ids are UUID-validated above.
        const video = (
          await sbGet(
            'video_generations',
            `id=eq.${encodeURIComponent(video_id)}&business_id=eq.${encodeURIComponent(business_id)}&select=*`
          )
        )[0];
        if (!video) {
          log('/webhook/video-generate', `Video ${video_id} not found for business ${business_id}`);
          return;
        }
        await _logGenUsage(business_id, 'generate_video_kling');

        // Parse script — may be stored as string or object
        let script = video.script;
        if (typeof script === 'string') {
          try {
            script = JSON.parse(script);
          } catch {
            script = {};
          }
        }
        const hookScene = script?.scenes?.[0];
        const promptText = hookScene?.text || video.hook_preview || video.caption || 'professional marketing video';
        const thumbUrl = video.thumbnail_url || '';

        log(
          '/webhook/video-generate',
          `promptText: "${promptText.slice(0, 80)}" | thumb: ${thumbUrl ? 'yes' : 'no'} | RUNWAY_KEY: ${RUNWAY_API_KEY ? 'set' : 'missing'}`
        );

        // Build Runway request — image_to_video requires promptImage
        const runwayBody = { model: 'gen3a_turbo', duration: 5, ratio: '768:1280', watermark: false };
        let endpoint = 'image_to_video';
        if (thumbUrl && thumbUrl.startsWith('http')) {
          runwayBody.promptImage = thumbUrl;
          runwayBody.promptText = promptText.slice(0, 512);
        } else {
          // No image — Runway image_to_video REQUIRES an image, so generate a placeholder first
          // Fall back to Pexels thumbnail
          try {
            const biz = (await sbGet('businesses', `id=eq.${business_id}&select=industry`))[0];
            const pexResult = await generateWithPexels(biz?.industry || 'business marketing');
            if (pexResult?.url) {
              runwayBody.promptImage = pexResult.url;
              runwayBody.promptText = promptText.slice(0, 512);
              log('/webhook/video-generate', `Generated Pexels placeholder thumbnail: ${pexResult.url}`);
            } else {
              log('/webhook/video-generate', 'No thumbnail and no Pexels fallback — cannot generate video');
              await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
              await logError(business_id, 'video-generate', 'No image available for image_to_video', {
                video_id,
              }).catch(() => {});
              return;
            }
          } catch (pexErr) {
            log('/webhook/video-generate', `Pexels fallback failed: ${pexErr.message}`);
            await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
            return;
          }
        }

        log('/webhook/video-generate', `Calling Runway ${endpoint}: ${JSON.stringify(runwayBody).slice(0, 200)}`);

        const taskResp = await apiRequest(
          'POST',
          `https://api.dev.runwayml.com/v1/${endpoint}`,
          {
            Authorization: `Bearer ${RUNWAY_API_KEY}`,
            'Content-Type': 'application/json',
            'X-Runway-Version': '2024-11-06',
          },
          runwayBody
        );

        log(
          '/webhook/video-generate',
          `Runway response: ${taskResp.status} ${JSON.stringify(taskResp.body).slice(0, 300)}`
        );

        const taskId = taskResp.body?.id;
        if (!taskId) {
          const errMsg = taskResp.body?.error || taskResp.body?.message || JSON.stringify(taskResp.body).slice(0, 300);
          log('/webhook/video-generate', `Runway failed to create task: ${errMsg}`);
          await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
          await logError(business_id, 'video-generate', `Runway ${taskResp.status}: ${errMsg}`, { video_id }).catch(
            () => {}
          );
          return;
        }

        log('/webhook/video-generate', `Task created: ${taskId} — polling for completion`);
        await sbPatch('video_generations', `id=eq.${video_id}`, { runway_task_id: taskId, status: 'generating' });

        // Poll for completion (max 5 minutes)
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const poll = await apiRequest('GET', `https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
            Authorization: `Bearer ${RUNWAY_API_KEY}`,
            'X-Runway-Version': '2024-11-06',
          });

          const pollStatus = poll.body?.status;
          if (i % 6 === 0) log('/webhook/video-generate', `Poll ${i}: status=${pollStatus}`);

          if (pollStatus === 'SUCCEEDED') {
            const videoUrl = poll.body.output?.[0];
            if (videoUrl) {
              const permUrl = await saveImageToSupabase(videoUrl, business_id);
              await sbPatch('video_generations', `id=eq.${video_id}`, { video_url: permUrl, status: 'ready' });
              sendSSE(business_id, 'video_ready', { video_id, url: permUrl });
              log('/webhook/video-generate', `✅ Video ready: ${permUrl}`);
            }
            break;
          }
          if (pollStatus === 'FAILED') {
            const failReason = poll.body?.failure || poll.body?.error || 'unknown';
            log('/webhook/video-generate', `❌ Runway task failed: ${failReason}`);
            await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
            await logError(business_id, 'video-generate', `Runway FAILED: ${failReason}`, { video_id, taskId }).catch(
              () => {}
            );
            break;
          }
        }
      } catch (err) {
        console.error('[video-generate ERROR]', err.message);
        log('/webhook/video-generate', `EXCEPTION: ${err.message}`);
        await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' }).catch(() => {});
        await logError(business_id, 'video-generate', err.message, { video_id }).catch(() => {});
      }
    });
  });

  // ── PIECE 9: Referral System ────────────────────────────────────────────────
  app.post('/webhook/referral-create', async (req, res) => {
    const { business_id, referee_email } = req.body;
    if (!business_id || !referee_email)
      return res.status(400).json({ error: 'business_id and referee_email required' });
    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=business_name,email,referral_code`))[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      const bizCode = biz.referral_code || crypto.randomBytes(4).toString('hex');
      if (!biz.referral_code)
        await sbPatch('businesses', `id=eq.${business_id}`, { referral_code: bizCode }).catch(() => {});
      // Unique code per referral to avoid duplicate key errors
      const refCode = bizCode + '-' + crypto.randomBytes(3).toString('hex');
      const ref = await sbPost('referrals', {
        referrer_business_id: business_id,
        referee_email,
        referral_code: refCode,
        status: 'pending',
      });
      const signupUrl = `https://maroa.ai/signup?ref=${refCode}`;
      await sendEmail(
        referee_email,
        `${biz.business_name} thinks maroa.ai could help you`,
        `<h2>You've been referred!</h2><p>${biz.business_name} thinks AI marketing could help your business.</p><p>Get <strong>30 days free</strong> when you sign up:</p><p><a href="${signupUrl}" style="background:#667eea;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Start Free →</a></p>`
      ).catch(() => {});
      res.json({ referral_id: ref?.id, referral_code: refCode, signup_url: signupUrl, email_sent: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/referral-convert', async (req, res) => {
    const { referral_code, new_business_id } = req.body;
    if (!referral_code) return res.status(400).json({ error: 'referral_code required' });
    try {
      const refs = await sbGet('referrals', `referral_code=eq.${referral_code}&status=eq.pending&limit=1`);
      if (!refs[0]) return res.json({ converted: false, reason: 'Referral not found or already used' });
      await sbPatch('referrals', `id=eq.${refs[0].id}`, {
        status: 'converted',
        referee_business_id: new_business_id || null,
      });
      res.json({ converted: true, referrer_business_id: refs[0].referrer_business_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/webhook/referral-stats', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const refs = await sbGet('referrals', `referrer_business_id=eq.${business_id}&select=status`);
      res.json({
        total: refs.length,
        converted: refs.filter((r) => r.status === 'converted').length,
        pending: refs.filter((r) => r.status === 'pending').length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PIECE 11: Predictive Revenue Forecasting ────────────────────────────────
  app.post('/webhook/revenue-forecast', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'Revenue forecast being generated' });
    setImmediate(async () => {
      try {
        const [bizArr, snaps, campaigns, contacts, revenue] = await Promise.all([
          sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,plan,marketing_goal`),
          sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=90`),
          sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status,roas,total_spend,daily_budget`),
          sbGet('contacts', `business_id=eq.${business_id}&select=lead_score,intent_level,stage`),
          sbGet('revenue_attribution', `business_id=eq.${business_id}&select=amount,source`).catch(() => []),
        ]);
        const biz = bizArr[0];
        if (!biz) return;
        const totalRev = revenue.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const totalReach = snaps.reduce((s, r) => s + (r.reach || 0), 0);
        const activeCamps = campaigns.filter((c) => c.status === 'active');
        const hotLeads = contacts.filter((c) => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
        const prompt = `You are a revenue forecasting AI for ${biz.business_name} (${biz.industry}).
Data: Revenue last 90d: $${totalRev.toFixed(2)} | Reach: ${totalReach} | Active campaigns: ${activeCamps.length} | Hot leads: ${hotLeads} | Total contacts: ${contacts.length} | Avg campaign ROAS: ${activeCamps.length ? (activeCamps.reduce((s, c) => s + (c.roas || 0), 0) / activeCamps.length).toFixed(2) : '0'}
Plan: ${biz.plan} | Goal: ${biz.marketing_goal || 'grow'}
Return ONLY valid JSON:
{"forecast_30d":{"revenue":0,"confidence":"low/medium/high"},"forecast_90d":{"revenue":0,"confidence":"low/medium/high"},"top_revenue_actions":[{"action":"string","expected_impact":"string","effort":"low/medium/high"}],"risk_factors":[{"risk":"string","probability":"low/medium/high"}],"forecast_summary":"2-3 sentences"}`;
        const forecast = await callClaude(prompt, 'strategy', 1500, { businessId: business_id });
        await sbPatch('businesses', `id=eq.${business_id}`, { revenue_forecast: JSON.stringify(forecast) });
        sendSSE(business_id, 'forecast_updated', { summary: forecast.forecast_summary });
        try {
          storeInsight(
            business_id,
            'forecast',
            'revenue_intelligence',
            'forecast_30d',
            forecast.forecast_30d?.revenue || '0'
          );
          storeInsight(
            business_id,
            'forecast',
            'revenue_intelligence',
            'forecast_summary',
            forecast.forecast_summary || ''
          );
        } catch {
          /* soft-fail */
        }
        log('/webhook/revenue-forecast', `✅ Forecast for ${biz.business_name}`);
      } catch (err) {
        console.error('[revenue-forecast ERROR]', err.message);
        await logError(business_id, 'revenue-forecast', err.message).catch(() => {});
      }
    });
  });

  // ── PIECE 13: Competitor Ad Spy ─────────────────────────────────────────────
  app.post('/webhook/spy-competitor-ads', async (req, res) => {
    const { business_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    res.json({ received: true, message: 'Competitor ad spy running' });
    setImmediate(async () => {
      try {
        const biz = (
          await sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,competitors,meta_access_token`)
        )[0];
        if (!biz?.meta_access_token) return;
        let competitors = [];
        try {
          competitors = JSON.parse(biz.competitors || '[]');
        } catch {
          /* soft-fail */
        }
        for (const comp of competitors.slice(0, 3)) {
          const name = typeof comp === 'string' ? comp : comp.name || comp;
          try {
            const r = await apiRequest(
              'GET',
              `https://graph.facebook.com/v19.0/ads_archive?search_terms=${encodeURIComponent(name)}&ad_reached_countries=["US"]&ad_type=ALL&fields=id,ad_creative_bodies,ad_creative_link_titles&limit=5&access_token=${biz.meta_access_token}`,
              {}
            );
            const ads = r.body?.data || [];
            for (const ad of ads) {
              await sbPost('competitor_ads', {
                business_id,
                competitor_name: name,
                ad_id: ad.id || `${name}-${Date.now()}`,
                ad_body: (ad.ad_creative_bodies || []).join(' ').slice(0, 1000),
                ad_headline: (ad.ad_creative_link_titles || []).join(' ').slice(0, 500),
              }).catch(() => {});
            }
          } catch {
            /* soft-fail */
          }
        }
        try {
          storeInsight(
            business_id,
            'competitor_ads',
            'competitive_intelligence',
            'competitor_ad_count',
            `${competitors.length} competitors monitored`
          );
        } catch {
          /* soft-fail */
        }
        log('/webhook/spy-competitor-ads', `✅ Spied on ${competitors.length} competitors for ${biz.business_name}`);
      } catch (err) {
        console.error('[spy-competitor-ads ERROR]', err.message);
      }
    });
  });

  // ── PIECE 15: Zapier/Make Webhook Subscriptions ─────────────────────────────
  app.post('/webhook/webhook-subscribe', async (req, res) => {
    const { business_id, event_type, webhook_url } = req.body;
    if (!business_id || !event_type || !webhook_url)
      return res.status(400).json({ error: 'business_id, event_type, webhook_url required' });
    if (!isUUID(String(business_id))) return res.status(400).json({ error: 'business_id must be a valid UUID' });
    if (typeof event_type !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(event_type))
      return res.status(400).json({ error: 'event_type is invalid' });
    // SSRF: a customer-supplied URL is fetched server-side and re-fetched on
    // every matching event. Reject non-https and anything resolving to a
    // private/loopback/link-local address (incl. cloud metadata).
    try {
      await assertPublicHttpUrl(webhook_url);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'webhook_url is not allowed' });
    }
    try {
      const secret = crypto.randomBytes(16).toString('hex');
      const sub = await sbPost('webhook_subscriptions', { business_id, event_type, webhook_url, secret, active: true });
      // Test ping
      apiRequest(
        'POST',
        webhook_url,
        { 'Content-Type': 'application/json', 'X-Maroa-Secret': secret },
        { event: 'test', business_id, message: 'Webhook connected successfully' },
        EXTERNAL_HTTP_TIMEOUT_MS,
        { allowInternalSecret: false }
      ).catch(() => {});
      res.json({ subscription_id: sub?.id, event_type, webhook_url, secret });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/webhook/webhook-list', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!isUUID(String(business_id))) return res.status(400).json({ error: 'business_id must be a valid UUID' });
    try {
      const subs = await sbGet(
        'webhook_subscriptions',
        `business_id=eq.${encodeURIComponent(business_id)}&active=eq.true&select=id,event_type,webhook_url,created_at`
      );
      res.json({ subscriptions: subs, count: subs.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/webhook/webhook-delete', async (req, res) => {
    const { subscription_id } = req.body;
    if (!subscription_id) return res.status(400).json({ error: 'subscription_id required' });
    if (!isUUID(String(subscription_id)))
      return res.status(400).json({ error: 'subscription_id must be a valid UUID' });
    try {
      await sbPatch('webhook_subscriptions', `id=eq.${encodeURIComponent(subscription_id)}`, { active: false });
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // 19 SKILL MODULES — Expert Marketing Automation
  // ═════════════════════════════════════════════════════════════════════════════

  // ── Shared Intelligence Layer ────────────────────────────────────────────────
  async function storeInsight(userId, sourceModule, insightType, insightKey, insightValue) {
    try {
      const val = typeof insightValue === 'object' ? JSON.stringify(insightValue) : String(insightValue || '');
      if (!val || val === '""') return;
      // Upsert: check if this key already exists for this user+module
      const existing = await sbGet(
        'business_intelligence',
        `user_id=eq.${userId}&source_module=eq.${sourceModule}&insight_key=eq.${encodeURIComponent(insightKey)}&select=id`
      ).catch(() => []);
      if (existing.length > 0) {
        await sbPatch('business_intelligence', `id=eq.${existing[0].id}`, {
          insight_value: val.slice(0, 2000),
          updated_at: new Date().toISOString(),
        });
      } else {
        await sbPost('business_intelligence', {
          user_id: userId,
          source_module: sourceModule,
          insight_type: insightType,
          insight_key: insightKey,
          insight_value: val.slice(0, 2000),
        });
      }
    } catch (err) {
      log('storeInsight', `${sourceModule}/${insightKey}: ${err.message}`);
    }
  }

  async function getAllIntelligence(userId) {
    try {
      return await sbGet('business_intelligence', `user_id=eq.${userId}&order=updated_at.desc&limit=50`);
    } catch {
      return [];
    }
  }

  async function buildIntelligenceContext(userId) {
    const rows = await getAllIntelligence(userId);
    if (!rows.length) return '';
    const grouped = {};
    for (const r of rows) {
      const mod = r.source_module || 'general';
      if (!grouped[mod]) grouped[mod] = [];
      grouped[mod].push(`${r.insight_key}: ${r.insight_value}`);
    }
    const lines = Object.entries(grouped).map(([mod, items]) => `[${mod}]\n${items.slice(0, 5).join('\n')}`);
    return `═══ SHARED INTELLIGENCE FROM ALL MODULES ═══\n${lines.join('\n\n')}\nUse this intelligence to inform all content.\n`;
  }

  // GET /api/intelligence/:userId — view all shared intelligence
  app.get('/api/intelligence/:userId', async (req, res) => {
    try {
      // IDOR guard — userId in path must equal the authenticated user.
      if (req.params.userId !== req.user?.id) {
        return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      }
      const rows = await getAllIntelligence(req.params.userId);
      const grouped = {};
      for (const r of rows) {
        if (!grouped[r.source_module]) grouped[r.source_module] = [];
        grouped[r.source_module].push({
          key: r.insight_key,
          value: r.insight_value,
          type: r.insight_type,
          updated: r.updated_at,
        });
      }
      res.json({ intelligence: grouped, total: rows.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper: fetch business profile for skill modules
  async function getProfile(userId) {
    let profile = null;
    let biz = null;
    // Fetch from both tables in parallel
    try {
      const [profileArr, bizArr1] = await Promise.all([
        sbGet('business_profiles', `user_id=eq.${userId}&select=*`).catch(() => []),
        sbGet('businesses', `id=eq.${userId}&select=*`).catch(() => []),
      ]);
      profile = profileArr[0] || null;
      biz = bizArr1[0] || null;
      if (!biz) {
        const bizArr2 = await sbGet('businesses', `user_id=eq.${userId}&select=*`).catch(() => []);
        biz = bizArr2[0] || null;
      }
    } catch {
      /* soft-fail */
    }

    // If detailed profile exists, merge businesses data into gaps
    if (profile) {
      if (biz) {
        if (!profile.business_name) profile.business_name = biz.business_name;
        if (!profile.business_type) profile.business_type = biz.industry;
        if ((!profile.physical_locations || !profile.physical_locations.length) && biz.location)
          profile.physical_locations = [{ city: biz.location }];
        if (!profile.audience_description) profile.audience_description = biz.target_audience;
        if (!profile.primary_goal) profile.primary_goal = biz.marketing_goal;
        if (!profile.monthly_budget && biz.daily_budget) profile.monthly_budget = '€' + biz.daily_budget * 30;
        if ((!profile.tone_keywords || !profile.tone_keywords.length) && biz.brand_tone)
          profile.tone_keywords = [biz.brand_tone];
        profile.plan = profile.plan || biz.plan;
      }
      return profile;
    }

    // Fall back to businesses table only
    if (biz) {
      return {
        user_id: userId,
        business_name: biz.business_name,
        business_type: biz.industry,
        physical_locations: biz.location ? [{ city: biz.location }] : [],
        primary_language: 'English',
        audience_description: biz.target_audience,
        primary_goal: biz.marketing_goal,
        monthly_budget: biz.daily_budget ? '€' + biz.daily_budget * 30 : '€300',
        tone_keywords: biz.brand_tone ? [biz.brand_tone] : [],
        usp: '',
        pain_point: '',
        we_do_better: '',
        current_offer: '',
        products: [],
        avg_spend: '',
        business_age: 'established',
        plan: biz.plan,
      };
    }

    log('getProfile', `No data found in either table for ${userId}`);
    return null;
  }
  function pCity(p) {
    const l = Array.isArray(p?.physical_locations) ? p.physical_locations : [];
    return l[0]?.city || 'local area';
  }

  require('./routes/ideas').register({
    app,
    getProfile,
    callClaude,
    pCity,
    claudeBiz,
    sbGet,
    sbPost,
    sbPatch,
    storeInsight,
    checkOrchestrationIdempotency,
    recordOrchestrationTaskRun,
    extractJSON,
    logError,
    log,
    safePublicError,
  });

  // Customer-facing "marketing skill" endpoints (Popup/RevOps/SEO/Sales/Pricing/
  // Schema/Signup-CRO/Free-tools/Upgrade/A-B/Community/Onboarding-CRO/Orchestrator
  // + AI chat + brand-DNA) the Lovable dashboard calls. Previously scaffolded with
  // auth middleware (above) but no handlers — these tabs 404'd until now.
  require('./routes/marketing-skills').register({
    app,
    getProfile,
    callClaude,
    claudeBiz,
    extractJSON,
    sbGet,
    sbPost,
    sbPatch,
    log,
    safePublicError,
    pCity,
  });

  require('./routes/lead-magnets').register({
    app,
    getProfile,
    callClaude,
    pCity,
    claudeBiz,
    sbGet,
    sbPost,
    storeInsight,
    checkOrchestrationIdempotency,
    recordOrchestrationTaskRun,
    log,
    safePublicError,
  });

  require('./routes/launch').register({
    app,
    getProfile,
    callClaude,
    pCity,
    claudeBiz,
    sbGet,
    sbPost,
    storeInsight,
    log,
    safePublicError,
  });

  require('./routes/research').register({
    app,
    getProfile,
    callClaude,
    pCity,
    claudeBiz,
    sbPost,
    storeInsight,
    log,
  });

  require('./routes/waitlist').register({
    app,
    validate,
    sbGet,
    sbPost,
    sendEmail,
    apiError,
    safePublicError,
  });

  // DEBUG: test getProfile directly
  app.get('/api/debug/profile/:userId', requireAdminSecret, async (req, res) => {
    const uid = req.params.userId;
    try {
      const p = await getProfile(uid);
      res.json({
        found: !!p,
        business_name: p?.business_name || null,
        business_type: p?.business_type || null,
        userId: uid,
      });
    } catch (err) {
      res.status(500).json({ found: false, error: 'Failed to fetch profile', userId: uid });
    }
  });

  // ── T2.2: GET /api/opportunities/:userId — Proactive opportunity detection ──
  app.get('/api/opportunities/:userId', async (req, res) => {
    try {
      if (req.params.userId !== req.user?.id) {
        return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      }
      const p = await getProfile(req.params.userId);
      const ops = await detectOpportunities(req.params.userId, p);
      res.json({ opportunities: ops, count: ops.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── T4.1: GET /api/metrics/:userId — Real analytics engine ──────────────────
  app.get('/api/metrics/:userId', async (req, res) => {
    try {
      const uid = req.params.userId;
      if (uid !== req.user?.id) {
        return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      }
      const weekMs = 7 * 86400000;
      const [content, ideas, intel, memory] = await Promise.all([
        sbGet(
          'generated_content',
          `business_id=eq.${uid}&order=created_at.desc&limit=50&select=created_at,status,content_theme`
        ).catch(() => []),
        sbGet('marketing_ideas', `user_id=eq.${uid}&status=eq.new&select=id`).catch(() => []),
        getAllIntelligence(uid),
        sbGet('ai_memory', `user_id=eq.${uid}&select=id`).catch(() => []),
      ]);
      const thisWeek = content.filter((c) => Date.now() - new Date(c.created_at).getTime() < weekMs);
      const published = thisWeek.filter((c) => c.status === 'published');
      res.json({
        posts_this_week: thisWeek.length,
        published_this_week: published.length,
        total_content: content.length,
        active_ideas: ideas.length,
        intelligence_signals: intel.length,
        memory_entries: memory.length,
        estimated_reach: published.length * 850,
        estimated_time_saved_hours: (thisWeek.length * 2.5).toFixed(1),
        estimated_cost_saved_eur: thisWeek.length * 45,
        trend: thisWeek.length >= 3 ? 'growing' : 'needs_attention',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── IMPROVEMENT 6: Content Calendar Engine ──────────────────────────────────
  app.post('/api/calendar/generate', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Generating 30-day content calendar' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const intel = await buildIntelligenceContext(userId);
        const { getKosovoAlbaniaHolidays, getSeason } = require('./services/masterPromptBuilder');
        const holidays =
          typeof getKosovoAlbaniaHolidays === 'function' ? getKosovoAlbaniaHolidays(new Date()).join(', ') : '';
        const season = typeof getSeason === 'function' ? getSeason(new Date()) : 'current';
        const prods = Array.isArray(p.products) ? p.products.map((pr) => pr.name).join(', ') : 'main service';
        const result = await callClaude(
          `You are a content calendar strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nLanguage: ${p.primary_language || 'English'}\nGoal: ${p.primary_goal}\nBudget: ${p.monthly_budget}\nProducts: ${prods}\nSeason: ${season}\nUpcoming holidays: ${holidays || 'none soon'}\n${intel}\n\nCreate a 30-day content calendar following content pillar framework:\n- 30% educational\n- 20% social proof\n- 20% behind the scenes\n- 20% engagement\n- 10% promotional\n\nReturn ONLY valid JSON:\n{"calendar":[{"day":1,"type":"educational|social_proof|behind_scenes|engagement|promotional","platform":"instagram|facebook|both","topic":"specific topic","caption_idea":"brief idea","hashtags":"3-5 relevant hashtags"}],"posting_frequency":"X posts per week","best_days":["string"]}`,
          'strategy',
          3000,
          claudeBiz(userId)
        );
        try {
          storeInsight(
            userId,
            'calendar',
            'content_strategy',
            'posting_plan',
            `${(result.calendar || []).length} days planned, ${result.posting_frequency || ''}`
          );
        } catch {
          /* soft-fail */
        }
        log('/api/calendar/generate', `✅ 30-day calendar for ${p.business_name}`);
      } catch (err) {
        console.error('[calendar]', err.message);
      }
    });
  });

  // ── IMPROVEMENT 7: Content Feedback Loop ────────────────────────────────────
  app.post('/api/content/feedback', validate('contentScore'), async (req, res) => {
    const { contentId, userId, action, editedVersion } = req.validatedBody;
    try {
      // Get content for memory storage (contentId is UUID-validated by the
      // contentScore zod schema). Fetch business_id so we can verify the JWT
      // caller actually owns this content before approving/rejecting/editing —
      // otherwise any user could mutate another tenant's content by id (IDOR).
      const contentRows = await sbGet(
        'generated_content',
        `id=eq.${encodeURIComponent(contentId)}&select=business_id,instagram_caption,content_theme`
      ).catch(() => []);
      if (!contentRows[0]) return apiError(res, 404, 'NOT_FOUND', 'content not found');
      const { assertBusinessOwner } = require('./lib/assertBusinessOwner');
      if (!(await assertBusinessOwner(req, res, contentRows[0].business_id, { sbGet, apiError, logger }))) return;
      const snippet = contentRows[0]?.instagram_caption?.slice(0, 200) || '';
      const theme = contentRows[0]?.content_theme || '';
      if (action === 'approved') {
        await sbPatch('generated_content', `id=eq.${contentId}`, {
          status: 'approved',
          approved_at: new Date().toISOString(),
          approval_method: 'client_feedback',
        });
        storeInsight(userId, 'feedback', 'content_preference', 'approved_style', `Approved: ${theme}`).catch(() => {});
        storeMemory(userId, 'content_wins', 'approved', snippet, 'social', `Client approved ${theme} content`).catch(
          () => {}
        );
      } else if (action === 'rejected') {
        await sbPatch('generated_content', `id=eq.${contentId}`, { status: 'rejected' });
        storeInsight(userId, 'feedback', 'content_preference', 'rejected_reason', `Rejected: ${theme}`).catch(() => {});
        storeMemory(
          userId,
          'content_losses',
          'rejected',
          snippet,
          'social',
          `Client rejected ${theme} — avoid this approach`
        ).catch(() => {});
      } else if (action === 'edited' && editedVersion) {
        await sbPatch('generated_content', `id=eq.${contentId}`, {
          status: 'approved',
          instagram_caption: editedVersion,
          approved_at: new Date().toISOString(),
          approval_method: 'client_edited',
        });
        storeInsight(userId, 'feedback', 'content_preference', 'edited_style', `Edited: ${theme}`).catch(() => {});
        storeMemory(
          userId,
          'preferences',
          'edited',
          editedVersion.slice(0, 200),
          'social',
          `Client prefers this style over AI draft`
        ).catch(() => {});
      }
      res.json({ success: true, action });
    } catch (err) {
      apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── IMPROVEMENT 9: Performance Tracking ─────────────────────────────────────
  app.post('/api/performance/update', async (req, res) => {
    const { userId, platform, metric, value, date, viewers } = req.body;
    if (!userId || !platform || !metric) return res.status(400).json({ error: 'userId, platform, metric required' });
    try {
      const payload = {
        business_id: userId,
        platform,
        [metric]: value || 0,
        snapshot_date: date || new Date().toISOString().slice(0, 10),
      };
      if (viewers != null) payload.viewers = viewers;
      if (metric === 'viewers') payload.reach = value || 0;
      await sbPost('analytics_snapshots', payload);
      storeInsight(userId, 'performance', 'performance_data', `${platform}_${metric}`, String(value || 0)).catch(
        () => {}
      );
      res.json({ stored: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/performance/summary/:userId', async (req, res) => {
    try {
      const uid = req.params.userId;
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const [thisWeek, lastWeek] = await Promise.all([
        sbGet(
          'analytics_snapshots',
          `business_id=eq.${uid}&snapshot_date=gte.${weekAgo}&select=reach,engagement,clicks,impressions`
        ),
        sbGet(
          'analytics_snapshots',
          `business_id=eq.${uid}&snapshot_date=gte.${twoWeeksAgo}&snapshot_date=lt.${weekAgo}&select=reach,engagement,clicks,impressions`
        ),
      ]);
      const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
      const tw = {
        reach: sum(thisWeek, 'reach'),
        engagement: sum(thisWeek, 'engagement'),
        clicks: sum(thisWeek, 'clicks'),
      };
      const lw = {
        reach: sum(lastWeek, 'reach'),
        engagement: sum(lastWeek, 'engagement'),
        clicks: sum(lastWeek, 'clicks'),
      };
      const change = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);
      res.json({
        this_week: tw,
        last_week: lw,
        change: {
          reach: change(tw.reach, lw.reach) + '%',
          engagement: change(tw.engagement, lw.engagement) + '%',
          clicks: change(tw.clicks, lw.clicks) + '%',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POWER: Business Health Score ─────────────────────────────────────────────
  app.get('/api/health/:userId', async (req, res) => {
    try {
      const uid = req.params.userId;
      if (uid !== req.user?.id) {
        return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      }
      const [p, content, intel, memory] = await Promise.all([
        getProfile(uid),
        sbGet(
          'generated_content',
          `business_id=eq.${uid}&order=created_at.desc&limit=30&select=created_at,status,content_theme`
        ).catch(() => []),
        getAllIntelligence(uid),
        sbGet('ai_memory', `user_id=eq.${uid}&select=id`).catch(() => []),
      ]);
      const weekMs = 7 * 86400000;
      const thisWeek = content.filter((c) => Date.now() - new Date(c.created_at).getTime() < weekMs);
      const published = thisWeek.filter((c) => c.status === 'published');
      const themes = [...new Set(thisWeek.map((c) => c.content_theme).filter(Boolean))];

      let profileScore = 0;
      try {
        const { calculateProfileScore } = require('./services/masterPromptBuilder');
        profileScore = p ? calculateProfileScore(p) : 0;
      } catch {
        /* soft-fail */
      }
      const postingScore = Math.min(20, published.length * 5);
      const varietyScore = Math.min(20, themes.length * 7);
      const engagementScore = Math.min(20, intel.length * 2);
      const competitiveScore = Math.min(
        20,
        intel.filter((i) => i.source_module === 'competitors' || i.source_module === 'moat').length * 5
      );
      const total = Math.min(
        100,
        Math.round(profileScore / 5) + postingScore + varietyScore + engagementScore + competitiveScore
      );

      const recs = [];
      if (profileScore < 70) recs.push('Complete your business profile to unlock better AI content');
      if (published.length < 3) recs.push('Publish at least 3 posts this week for algorithm reach');
      if (themes.length < 2) recs.push('Vary your content themes — mix educational, promotional, and social proof');
      if (intel.length < 5) recs.push('Run competitor analysis and customer research to feed the AI');

      res.json({
        total,
        profile: Math.round(profileScore / 5),
        posting: postingScore,
        variety: varietyScore,
        engagement: engagementScore,
        competitive: competitiveScore,
        recommendations: recs,
        memory_entries: memory.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POWER: Instant Campaign Generator ───────────────────────────────────────
  app.post('/api/campaigns/instant', validate('campaign'), async (req, res) => {
    const { userId, goal, duration = 7 } = req.validatedBody;
    res.json({ received: true, message: `Building ${duration}-day campaign: ${goal}` });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const intel = await buildIntelligenceContext(userId);
        const mem = await getMemoryContext(userId);
        const result = await callClaude(
          `You are a campaign strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nGoal: ${goal}\nDuration: ${duration} days\nBudget: ${p.monthly_budget}\nLanguage: ${p.primary_language}\nProducts: ${(p.products || []).map((pr) => pr.name).join(', ')}\n${intel}\n${mem}\n\nCreate a complete ${duration}-day campaign:\n- ${duration} social posts (one per day, specific topic and caption)\n- 2 emails (start and end of campaign)\n- 1 ad copy (Meta)\n- Campaign hashtag\n- Best posting schedule\n\nReturn ONLY valid JSON:\n{"campaign_name":"string","theme":"string","posts":[{"day":1,"platform":"string","topic":"string","caption":"string"}],"emails":[{"type":"start|end","subject":"string","body":"string"}],"ad":{"headline":"string","body":"string"},"hashtag":"string"}`,
          'strategy',
          4000,
          claudeBiz(userId)
        );
        try {
          storeInsight(userId, 'campaigns', 'campaign_strategy', 'active_campaign', result.campaign_name || goal);
        } catch {
          /* soft-fail */
        }
        log('/api/campaigns/instant', `✅ ${duration}-day campaign: ${result.campaign_name || goal}`);
      } catch (err) {
        console.error('[campaigns/instant]', err.message);
      }
    });
  });

  // ── POWER: Content Repurposer ───────────────────────────────────────────────
  app.post('/api/content/repurpose', async (req, res) => {
    const { userId, originalContent, targetPlatforms } = req.body;
    if (!userId || !originalContent) return res.status(400).json({ error: 'userId and originalContent required' });
    res.json({ received: true, message: 'Repurposing content for all platforms' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const platforms = targetPlatforms || ['instagram', 'facebook', 'email', 'whatsapp'];
        const result = await callClaude(
          `Repurpose this content for ${p.business_name} across platforms.\nOriginal:\n"${originalContent.slice(0, 1000)}"\n\nLanguage: ${p.primary_language}\nCity: ${pCity(p)}\n\nCreate versions for: ${platforms.join(', ')}\n\nReturn ONLY valid JSON:\n{"versions":[{"platform":"string","content":"string","hashtags":"string","format":"string"}]}`,
          'social_post',
          2000,
          claudeBiz(userId)
        );
        log('/api/content/repurpose', `✅ ${(result.versions || []).length} platform versions`);
      } catch (err) {
        console.error('[content/repurpose]', err.message);
      }
    });
  });

  // ── POWER: Smart Competitor Counter ─────────────────────────────────────────
  app.post('/api/compete/counter', async (req, res) => {
    const { userId, competitorAction } = req.body;
    if (!userId || !competitorAction) return res.status(400).json({ error: 'userId and competitorAction required' });
    res.json({ received: true, message: 'Generating counter-strategy' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const result = await callClaude(
          `A competitor of ${p.business_name} just did this: "${competitorAction}"\n\nBusiness: ${p.business_type} in ${pCity(p)}\nOur USP: ${p.usp}\nOur advantage: ${p.we_do_better}\nLanguage: ${p.primary_language}\n\nGenerate counter-strategy:\n- 3 social posts positioning us as the better choice\n- 1 email to existing customers reinforcing loyalty\n- 1 ad copy countering their move\n\nReturn ONLY valid JSON:\n{"posts":["string"],"email":{"subject":"string","body":"string"},"ad":{"headline":"string","body":"string"},"strategy":"string"}`,
          'strategy',
          2000,
          claudeBiz(userId)
        );
        try {
          storeInsight(
            userId,
            'compete',
            'competitive_intelligence',
            'counter_strategy',
            result.strategy || competitorAction
          );
        } catch {
          /* soft-fail */
        }
        log('/api/compete/counter', `✅ Counter-strategy for ${p.business_name}`);
      } catch (err) {
        console.error('[compete/counter]', err.message);
      }
    });
  });

  // ── POWER: Weekly Strategy Report ───────────────────────────────────────────
  app.get('/api/strategy/weekly/:userId', async (req, res) => {
    try {
      const uid = req.params.userId;
      if (await checkOrchestrationIdempotency(uid, 'weekly_strategy_report')) {
        return res.json({ skipped: true, reason: 'already_ran_recently' });
      }
      const p = await getProfile(uid);
      if (!p) return apiError(res, 404, 'NOT_FOUND', 'Profile not found');
      const intel = await buildIntelligenceContext(uid);
      const mem = await getMemoryContext(uid);
      const result = await callClaude(
        `Weekly strategy report for ${p.business_name} (${p.business_type} in ${pCity(p)}).\nLanguage: ${p.primary_language}\n${intel}\n${mem}\n\nGenerate:\n1. What worked this week (from intelligence)\n2. What to focus on next week\n3. 5 content ideas for next 7 days\n4. Budget recommendation\n5. One key competitor insight\n\nReturn ONLY valid JSON:\n{"what_worked":"string","next_week_focus":"string","content_ideas":["string"],"budget_recommendation":"string","competitor_insight":"string","overall_grade":"A|B|C|D"}`,
        'strategy',
        1500,
        claudeBiz(uid)
      );
      await recordOrchestrationTaskRun(uid, 'weekly_strategy_report');
      res.json(result);
    } catch (err) {
      if (err?.code === 'AI_BUDGET_EXCEEDED' || err?.status === 402) {
        return apiError(res, 402, 'AI_BUDGET_EXCEEDED', err.message || 'Daily AI call limit reached');
      }
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── POWER: Auto Review Responder ────────────────────────────────────────────
  app.post('/api/reviews/auto-respond', async (req, res) => {
    const { userId, reviewText, rating, platform } = req.body;
    if (!userId || !reviewText) return res.status(400).json({ error: 'userId and reviewText required' });
    try {
      const p = await getProfile(userId);
      const stars = rating || 5;
      const tone = stars >= 4 ? 'warm, grateful, subtly promotional' : 'empathetic, solution-focused, recovery-minded';
      const result = await callClaude(
        `Write a review response for ${p?.business_name || 'the business'}.\nReview (${stars} stars): "${reviewText}"\nPlatform: ${platform || 'google'}\nTone: ${tone}\nLanguage: ${p?.primary_language || 'English'}\n\nRules:\n- ${stars >= 4 ? 'Thank warmly, mention specific detail, invite back' : 'Apologize sincerely, offer solution, invite offline resolution'}\n- Max 100 words\n- Never templated — unique to this review\n\nReturn ONLY valid JSON:\n{"response":"string","tone":"string","suggested_action":"string"}`,
        'short_copy',
        400,
        claudeBiz(userId)
      );
      try {
        if (stars <= 2)
          storeInsight(userId, 'reviews', 'customer_voice', 'complaint_pattern', reviewText.slice(0, 100));
      } catch {
        /* soft-fail */
      }
      res.json(result);
    } catch (err) {
      if (err?.code === 'AI_BUDGET_EXCEEDED' || err?.status === 402) {
        return apiError(res, 402, 'AI_BUDGET_EXCEEDED', err.message || 'Daily AI call limit reached');
      }
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ── MODULE 1: Referral Program (carved into routes/referral.js) ─────────────
  require('./routes/referral').register({
    app,
    getProfile,
    callClaude,
    pCity,
    claudeBiz,
    sbGet,
    sbPost,
    storeInsight,
    log,
    safePublicError,
  });

  // ─── POST /api/generate — Plan-gated generation with usage tracking ─────────
  const GENERATE_MODELS = {
    generate_image: { model_used: 'higgsfield-soul', credits_used: 3 },
    generate_video_kling: { model_used: 'kling-3.0', credits_used: 6 },
    generate_video_sora: { model_used: 'sora-2', credits_used: 50 },
    process_product: { model_used: 'product-catalog', credits_used: 10 },
    score_content: { model_used: 'claude-vision-score', credits_used: 1 },
    generate_caption: { model_used: 'claude-caption', credits_used: 1 },
  };

  async function monthlyUsageCount(userId, action) {
    try {
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const rows = await sbGet(
        'usage_logs',
        `user_id=eq.${userId}&action=eq.${action}&created_at=gte.${monthStart}&select=id`
      );
      return Array.isArray(rows) ? rows.length : 0;
    } catch {
      return 0;
    }
  }

  app.post('/api/generate', checkPlanLimit, async (req, res) => {
    try {
      const { user_id, action } = req.body;
      const model = GENERATE_MODELS[action];
      if (!model) return apiError(res, 400, 'INVALID_ACTION', `Unknown action: ${action}`);

      const {
        product_image_url,
        product_image_urls,
        brand_dna,
        image_url,
        video_url,
        caption,
        platform_data,
        platform,
        score,
        business_id,
        prompt,
      } = req.body;

      let extra = {};

      if (action === 'process_product') {
        const imgs =
          Array.isArray(product_image_urls) && product_image_urls.length
            ? product_image_urls
            : product_image_url
              ? [product_image_url]
              : [];
        if (!imgs.length)
          return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_urls or product_image_url required');
        const [imgU, kU, sU] = await Promise.all([
          monthlyUsageCount(user_id, 'generate_image'),
          monthlyUsageCount(user_id, 'generate_video_kling'),
          monthlyUsageCount(user_id, 'generate_video_sora'),
        ]);
        const L = req.planLimits || {};
        const remaining = {
          images: Math.max(0, (L.images || 0) - imgU),
          kling: Math.max(0, (L.kling || 0) - kU),
          sora: Math.max(0, (L.sora || 0) - sU),
        };
        extra = await higgsfieldAI.processProductCatalog(user_id, business_id || user_id, imgs, brand_dna || {}, {
          plan: req.userPlan,
          planLimits: L,
          remaining,
        });
      } else if (action === 'generate_image') {
        if (!product_image_url) return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_url required');
        extra = {
          image_urls: await higgsfieldAI.generateProductImage(product_image_url, brand_dna || {}, {
            prompt: typeof prompt === 'string' ? prompt : undefined,
            userId: user_id,
          }),
        };
      } else if (action === 'generate_video_kling') {
        if (!product_image_url) return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_url required');
        extra = { video_url: await higgsfieldAI.generateProductVideo(product_image_url, brand_dna || {}) };
      } else if (action === 'generate_video_sora') {
        if (!product_image_url) return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_url required');
        extra = { video_url: await higgsfieldAI.generateHeroAd(product_image_url, brand_dna || {}) };
      } else if (action === 'score_content') {
        extra = await higgsfieldAI.scoreContent(
          image_url || null,
          video_url || null,
          caption || '',
          brand_dna || {},
          platform_data || {},
          { userId: user_id }
        );
      } else if (action === 'generate_caption') {
        if (!platform) return apiError(res, 400, 'VALIDATION_ERROR', 'platform required');
        extra = await higgsfieldAI.generateCaption(image_url, brand_dna || {}, platform, score, { plan: req.userPlan });
      }

      await sbPost('usage_logs', {
        user_id,
        action,
        plan_name: req.userPlan,
        model_used: model.model_used,
        credits_used: model.credits_used,
        status: 'success',
      }).catch(() => {});

      res.json({
        success: true,
        action,
        plan: req.userPlan,
        model_used: model.model_used,
        credits_used: model.credits_used,
        ...extra,
      });
    } catch (err) {
      logger.error('/api/generate', req.body?.user_id, 'Generate failed', err);
      try {
        await sbPost('usage_logs', {
          user_id: req.body?.user_id,
          action: req.body?.action,
          plan_name: req.userPlan || 'unknown',
          model_used: 'error',
          credits_used: 0,
          status: 'failed',
        }).catch(() => {});
      } catch {
        /* ignore */
      }
      const httpStatus =
        err && typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
      apiError(
        res,
        httpStatus,
        typeof err.code === 'string' && err.code ? err.code : 'GENERATE_ERROR',
        err.message || 'Generate failed'
      );
    }
  });

  // ─── Workflow #1 routes (Daily Content Engine) ──────────────────────────────
  // Registered after legacy routes so WF1 takes precedence on its wf1-* paths.
  registerWf1Routes({ app, wf1, sbGet, sbPost, sbPatch, apiError, logger });

  // ─── Workflow #13 routes (Weekly Strategy Brief) ────────────────────────────
  registerWf13Routes({ app, wf13, sbGet, sbPost, sbPatch, apiError, logger });

  // ─── Workflow #15 routes (AI Brain) ─────────────────────────────────────────
  registerWf15Routes({ app, wf15, sbGet, sbPost, sbPatch, apiError, logger });

  // ─── Workflow #2 routes (Lead Scoring & Routing) ────────────────────────────
  registerWf2Routes({ app, wf2, apiError, logger });

  // ─── Ad Optimizer routes (user-facing WF02 — Daily Ad Optimizer) ───────────
  adOptimizer.registerRoutes({ app, apiError });

  // ─── AI-SEO routes (NEW — citability for AI assistants) ───────────────────
  aiSeo.registerRoutes({ app, apiError });

  // ─── CRO routes (NEW — landing page audit + rewrite) ──────────────────────
  croService.registerRoutes({ app, apiError });

  // ─── Pacing Alerts routes (between daily ad audits) ───────────────────────
  pacingAlerts.registerRoutes({ app, apiError });

  // ─── Weekly Scorecard routes (replaces WF17 monthly report) ───────────────
  weeklyScorecard.registerRoutes({ app, apiError });

  // ─── Forecasting routes (predictive) ──────────────────────────────────────
  forecasting.registerRoutes({ app, apiError });

  // ─── VOC routes (Voice-of-Customer mining) ────────────────────────────────
  vocService.registerRoutes({ app, apiError });

  // ─── Workflow #4 routes (Reviews & Reputation) ──────────────────────────────
  registerWf4Routes({ app, wf4, apiError, logger });

  // ─── Workflow #3 routes (Ad Optimization) ──────────────────────────────────
  registerWf3Routes({ app, wf3, apiError, logger });

  // ─── Workflows #5, #6, #7, #8, #9/11, #10, #12, #14 — batch routes ─────────
  registerBatchRoutes({ app, wf5, wf6, wf7, wf8, wf9, wf10, wf12, wf14, wf11, apiError, logger });
  registerWf11Routes({ app, wf11, apiError, logger });

  // ─── Creative Director (Cannes-grade strategy) + Soul ID character routes ──
  const { registerCreativeRoutes } = require('./services/creative/registerRoutes');
  registerCreativeRoutes({
    app,
    hfService: higgsfieldAI,
    sbGet,
    sbPost,
    sbPatch,
    apiError,
    logger,
    checkOrchestrationIdempotency,
  });

  // ─── Anthropic 2026 features: Files / Batch / Citations / Memory / Agents ──
  const { createFilesService } = require('./services/anthropic-files');
  const { createBatchService } = require('./services/anthropic-batch');
  const anthropicCitations = require('./services/anthropic-citations');
  const { createMemoryService } = require('./services/anthropic-memory');
  const { createManagedAgentService } = require('./services/managed-agent');
  const { registerAnthropicRoutes } = require('./services/anthropic/registerRoutes');

  const _anthropicApiKey = ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
  let managedAgentService = null;
  if (_anthropicApiKey) {
    const filesService = createFilesService({ apiKey: _anthropicApiKey, logger });
    const batchService =
      _batchServiceForWf1 || createBatchService({ apiKey: _anthropicApiKey, logger, sbGet, sbPost, sbPatch });
    memoryService = createMemoryService({ apiKey: _anthropicApiKey, logger });
    managedAgentService = createManagedAgentService({ apiKey: _anthropicApiKey, logger });

    registerAnthropicRoutes({
      app,
      sbGet,
      sbPost,
      sbPatch,
      sbDelete,
      apiError,
      logger,
      checkOrchestrationIdempotency,
      filesService,
      batchService,
      memoryService,
      managedAgentService,
      citations: anthropicCitations,
      callClaude,
    });
  } else {
    logger.warn('boot', null, 'Anthropic 2026 routes skipped — ANTHROPIC_KEY not set');
  }

  const { createDeepDiveService } = require('./services/deep-dive');
  const deepDiveService =
    _anthropicApiKey && managedAgentService
      ? createDeepDiveService({ managedAgentService, sbGet, sbPost, logger })
      : null;

  const { createMonthlyReportService } = require('./services/monthly-report');
  const monthlyReportService = createMonthlyReportService({ sbGet, callClaude, logger });

  // POST /api/business/:businessId/monthly-report — Code execution analytics (Growth+)
  app.post('/api/business/:businessId/monthly-report', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    try {
      const out = await monthlyReportService.generate({
        businessId,
        month: req.body?.month,
      });
      if (!out.ok) {
        const code = out.reason === 'plan_upgrade_required' ? 403 : 404;
        return apiError(res, code, out.reason?.toUpperCase() || 'REPORT_FAILED', out.reason);
      }
      return res.json(out);
    } catch (err) {
      return apiError(res, 500, 'MONTHLY_REPORT_FAILED', err.message);
    }
  });

  // POST /api/business/:businessId/marketing-deep-dive — Agency async research (Managed Agents)
  app.post('/api/business/:businessId/marketing-deep-dive', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    try {
      const out = await deepDiveService.runMarketingDeepDive({
        businessId,
        brief: req.body?.brief || req.body?.prompt,
        context: req.body?.context || {},
      });
      if (!out.ok) {
        const code = out.reason === 'agency_plan_required' ? 403 : 404;
        return apiError(res, code, out.reason?.toUpperCase() || 'DEEP_DIVE_FAILED', out.reason);
      }
      return res.json(out);
    } catch (err) {
      return apiError(res, 500, 'DEEP_DIVE_FAILED', err.message);
    }
  });

  // ─── Real OAuth flows — Meta + Google (per-customer token capture) ──────────
  const { registerMetaOAuthRoutes } = require('./services/oauth/meta');
  const { registerGoogleOAuthRoutes } = require('./services/oauth/google');

  // JWT verifier passed to OAuth start handlers. Binds the OAuth state token
  // to the authenticated Supabase user — prevents the account-takeover where
  // an attacker could call /webhook/oauth/.../start?businessId=<victim>.
  const supabaseAdminForOAuth = (() => {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const url = SUPABASE_URL;
      const key = env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY;
      if (!url || !key) return null;
      return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch {
      return null;
    }
  })();
  async function verifyUserJwt(token) {
    if (!supabaseAdminForOAuth) return null;
    const { data, error } = await supabaseAdminForOAuth.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  }

  registerMetaOAuthRoutes({
    app,
    sbGet,
    sbPatch,
    sbPost,
    apiError,
    logger,
    verifyUserJwt,
  });
  registerGoogleOAuthRoutes({
    app,
    sbGet,
    sbPatch,
    sbPost,
    apiError,
    logger,
    verifyUserJwt,
  });

  // ─── Cold-start onboarding ──────────────────────────────────────────────────
  // Drives a new business through industry-classify → competitor-detect →
  // brand-voice → Soul ID → concepts → campaign launch → content → AI-SEO.
  // State machine in cold_start_runs (migration 045). Inngest functions
  // `cold-start-run` and `cold-start-resume` drive durable execution.
  const coldStartService = require('./services/cold-start');
  const { registerColdStartRoutes } = require('./services/cold-start/registerRoutes');
  const creativeDirectorPrompts = require('./services/prompts/creative-director');
  const aiSeoForColdStart = (() => {
    // ai-seo's cold-start API hook — only call .runBaseline if it exists. The
    // existing service exposes a route handler, so we wrap it here as a no-op
    // until ai-seo gets a programmatic baseline runner (Week 9).
    try {
      return require('./services/ai-seo');
    } catch {
      return null;
    }
  })();
  const higgsfieldForColdStart = createHiggsfieldService({
    apiRequest,
    serpSearch,
    logger,
    extractJSON,
    sbGet,
    sbPost,
    sbPatch,
    ANTHROPIC_KEY,
    SERPAPI_KEY,
    SUPABASE_URL,
    SUPABASE_KEY,
    callClaude,
  });
  const wf1ForColdStart = (() => {
    try {
      return require('./services/wf1');
    } catch {
      return null;
    }
  })();

  registerColdStartRoutes({
    app,
    apiError,
    logger,
    sentry: Sentry,
    sbGet,
    sbPost,
    sbPatch,
    // sbRpc enables atomic cold-start concept seeding via the migration-071
    // RPC (cold_start_initialize). Falls back to the legacy two-call path
    // in services/cold-start/phases.js on RPC_NOT_FOUND.
    sbRpc,
    callClaude,
    brandVoice: brandVoiceService,
    creativeDirector: creativeDirectorPrompts,
    higgsfield: higgsfieldForColdStart,
    adOptimizer,
    aiSeo: aiSeoForColdStart,
    wf1: wf1ForColdStart,
    coldStart: coldStartService,
    // Enables the 72h reminder email in the stale-run sweep (cold-start-sweep
    // cron). Without it the sweep still expires abandoned runs at 7d.
    sendEmail,
  });

  // ─── Multi-platform ads + Daily Creative Engine + Measurement Health (Week 5-7)
  //     + Competitor War Room (Week 8) + AI Citation Tracker (Week 9)
  const creativeEngineService = require('./services/creative-engine');
  const measurementHealthService = require('./services/measurement-health');
  const competitorWatchService = require('./services/competitor-watch');
  const citationTrackerService = require('./services/citation-tracker');
  const socialMultiService = require('./services/social-multi');
  const { registerCreativeEngineRoutes } = require('./services/creative-engine/registerRoutes');

  // Multi-platform social posting endpoints (Week 11)
  app.post('/webhook/social-post-now', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    const platforms = req.body?.platforms;
    const content = req.body?.content || { body: req.body?.body || '' };
    const mediaUrl = req.body?.mediaUrl || req.body?.media_url;
    if (!businessId || !Array.isArray(platforms) || platforms.length === 0) {
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + platforms required');
    }
    try {
      const r = await socialMultiService.postNow({
        businessId,
        platforms,
        content,
        mediaUrl,
        deps: { sbGet, sbPost, logger },
      });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'SOCIAL_POST_FAILED', e.message);
    }
  });

  app.post('/webhook/social-post-schedule', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    const platforms = req.body?.platforms;
    const content = req.body?.content || { body: req.body?.body || '' };
    const mediaUrl = req.body?.mediaUrl || req.body?.media_url;
    const scheduleAt = req.body?.scheduleAt || req.body?.schedule_at;
    if (!businessId || !Array.isArray(platforms) || !scheduleAt) {
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + platforms + scheduleAt required');
    }
    try {
      const r = await socialMultiService.schedulePost({
        businessId,
        platforms,
        content,
        mediaUrl,
        scheduleAt,
        deps: { sbGet, sbPost, logger },
      });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'SOCIAL_SCHEDULE_FAILED', e.message);
    }
  });

  // ─── Email Lifecycle (Week 10) — adapter wires existing Resend sendEmail ─
  const emailLifecycleService = require('./services/email-lifecycle');

  // Adapter — email-lifecycle expects { to, subject, html, metadata } and
  // returns { ok, id?, reason? }. The existing sendEmail(to, subject, html)
  // returns { sent, id, error }. Adapter normalizes both directions.
  async function sendEmailViaResend(args) {
    const { to, subject, html, metadata } = args || {};
    try {
      const r = await sendEmail(to, subject, html);
      if (r?.sent) return { ok: true, id: r.id, metadata };
      if (r?.queued) return { ok: false, reason: 'queued (RESEND_API_KEY missing)' };
      return { ok: false, reason: r?.error || `HTTP ${r?.status}` };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async function runEmailLifecycleProcessDue() {
    return emailLifecycleService.processDueRuns({
      deps: { sbGet, sbPatch, sendEmail: sendEmailViaResend, logger },
    });
  }
  internalDispatcher.register('/webhook/email-lifecycle-process-due', () => runEmailLifecycleProcessDue());
  app.post('/webhook/email-lifecycle-process-due', requireWebhookSource, async (req, res) => {
    try {
      const r = await runEmailLifecycleProcessDue();
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'EMAIL_LIFECYCLE_PROCESS_FAILED', e.message);
    }
  });

  app.post('/webhook/email-lifecycle-enroll', async (req, res) => {
    const { businessId, stage, email, name } = req.body || {};
    if (!businessId || !stage || !email) {
      return apiError(res, 400, 'INVALID_REQUEST', 'businessId + stage + email required');
    }
    try {
      const r = await emailLifecycleService.enrollRecipient({
        businessId,
        stage,
        email,
        name,
        deps: { sbGet, sbPost, logger },
      });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'EMAIL_LIFECYCLE_ENROLL_FAILED', e.message);
    }
  });

  app.post('/webhook/email-lifecycle-bootstrap', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await emailLifecycleService.ensureSequencesForBusiness({
        businessId,
        deps: { sbGet, sbPost, logger },
      });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'EMAIL_LIFECYCLE_BOOTSTRAP_FAILED', e.message);
    }
  });

  // ─── Higgsfield: Soul ID training + daily credit check ──────────────────
  // POST /api/higgsfield/train-soul — kicks off Soul ID training, then fires
  // higgsfield/soul-train.poll so a durable Inngest function waits for the
  // training to complete and stamps businesses.higgsfield_soul_id.
  app.post('/api/higgsfield/train-soul', async (req, res) => {
    const businessId = String((req.body && (req.body.business_id || req.body.businessId)) || '').trim();
    const photoUrls = Array.isArray(req.body?.photoUrls || req.body?.photo_urls)
      ? req.body.photoUrls || req.body.photo_urls
      : null;
    const name = req.body?.name || null;
    const model = req.body?.model || 'soul_2';
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'business_id required');
    if (!photoUrls || photoUrls.length === 0) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'photoUrls[] (1-20) required');
    }
    if (photoUrls.length > 20) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'photoUrls capped at 20');
    }
    try {
      const trained = await higgsfieldAI.trainSoulCharacter({
        characterId: `${businessId}-soul-${Date.now()}`,
        sourceImageUrls: photoUrls,
        name: name || `business-${businessId}`,
        model,
      });
      const higgsfieldCharacterId = trained?.higgsfield_character_id;
      if (!higgsfieldCharacterId) {
        return apiError(res, 502, 'SOUL_TRAIN_FAILED', 'no character_id returned from Higgsfield');
      }
      // Durable poll → finalize (writes businesses.higgsfield_soul_id when done).
      const { inngest } = require('./services/inngest/client');
      await inngest.send({
        name: 'higgsfield/soul-train.poll',
        data: { businessId, characterId: higgsfieldCharacterId },
      });
      res.json({
        ok: true,
        business_id: businessId,
        character_id: higgsfieldCharacterId,
        status: 'training_started',
        model_used: trained.model_used,
        image_count: trained.image_count,
      });
    } catch (e) {
      apiError(res, 500, 'SOUL_TRAIN_FAILED', e.message);
    }
  });

  // POST /webhook/higgsfield-soul-train-finalize — invoked by the Inngest
  // higgsfieldSoulTrainPoll function. Waits for training to complete (uses
  // the existing internal poller), then stamps businesses.higgsfield_soul_id.
  async function runHiggsfieldSoulTrainFinalize({ businessId, characterId }) {
    if (!businessId || !characterId) {
      throw new Error('businessId + characterId required');
    }
    const status = await higgsfieldAI.waitForSoulIdTraining(characterId);
    const soulId = status?.higgsfield_character_id || characterId;
    await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
      higgsfield_soul_id: soulId,
    }).catch(() => {});
    return { ok: true, business_id: businessId, soul_id: soulId, status: status?.status || 'completed' };
  }
  internalDispatcher.register('/webhook/higgsfield-soul-train-finalize', (body) =>
    runHiggsfieldSoulTrainFinalize({
      businessId: body?.businessId || body?.business_id,
      characterId: body?.characterId,
    })
  );
  app.post('/webhook/higgsfield-soul-train-finalize', async (req, res) => {
    try {
      res.json(
        await runHiggsfieldSoulTrainFinalize({
          businessId: String(req.body?.businessId || req.body?.business_id || '').trim(),
          characterId: String(req.body?.characterId || '').trim(),
        })
      );
    } catch (e) {
      apiError(res, 500, 'SOUL_TRAIN_WAIT_FAILED', e.message);
    }
  });

  // POST /webhook/check-higgsfield-credits — invoked by the daily 07:00 UTC
  // Inngest cron. Tries to refresh each business's Higgsfield balance (no-op
  // until the REST balance endpoint is wired — Integration #2), then emails
  // a low-balance alert to any business with credits < 200.
  async function runCheckHiggsfieldCredits() {
    // HONEST STATE: getBalance() is a stub (no Higgsfield balance REST endpoint
    // yet), so higgsfield_credits is only ever populated by (a) that future
    // endpoint or (b) an operator-set HIGGSFIELD_DEFAULT_CREDITS starting grant
    // that we seed here. The previous version filtered `higgsfield_credits=
    // not.is.null`, which silently scanned ZERO rows forever (the column was
    // never written) — so the guard + alerts never fired. We now scan all
    // businesses, optionally seed, and report whether monitoring is actually
    // active instead of pretending.
    const defaultGrant = parseInt(env.HIGGSFIELD_DEFAULT_CREDITS, 10);
    const seedEnabled = Number.isFinite(defaultGrant) && defaultGrant > 0;
    const businesses = await sbGet('businesses', `select=id,business_name,email,higgsfield_credits`).catch(() => []);
    let refreshed = 0;
    let seeded = 0;
    let alerted = 0;
    for (const biz of businesses) {
      try {
        const bal = await higgsfieldAI.getBalance({ business: biz });
        if (bal?.ok && typeof bal.credits === 'number') {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(biz.id)}`, {
            higgsfield_credits: bal.credits,
            higgsfield_credits_checked_at: new Date().toISOString(),
          }).catch(() => {});
          biz.higgsfield_credits = bal.credits;
          refreshed++;
        }
      } catch {
        /* soft-fail refresh */
      }
      // Seed an operator-configured starting grant for businesses with no known
      // balance, so the guard + alert path can actually fire. Opt-in only.
      if (seedEnabled && biz.higgsfield_credits == null) {
        await sbPatch('businesses', `id=eq.${encodeURIComponent(biz.id)}`, {
          higgsfield_credits: defaultGrant,
          higgsfield_credits_checked_at: new Date().toISOString(),
        }).catch(() => {});
        biz.higgsfield_credits = defaultGrant;
        seeded++;
      }
      const credits = Number(biz.higgsfield_credits);
      if (Number.isFinite(credits) && credits < 200 && biz.email) {
        try {
          await sendEmail(
            biz.email,
            `Maroa.ai — Higgsfield image credits running low (${credits} left)`,
            `<p>Hi ${biz.business_name || 'there'},</p>` +
              `<p>Your Higgsfield image-generation balance is at <b>${credits}</b> credits — below our 200-credit safety floor.</p>` +
              `<p>Generation will pause automatically once you drop under 100 credits, to avoid mid-post failures. Top up to keep your daily content flowing.</p>` +
              `<p>— Maroa.ai</p>`
          );
          alerted++;
        } catch (e) {
          logger?.warn?.('check-higgsfield-credits', biz.id, 'alert email failed', { error: e.message });
        }
      }
    }
    const monitoringActive = seedEnabled || refreshed > 0;
    if (!monitoringActive) {
      logger?.warn?.(
        'check-higgsfield-credits',
        null,
        'credit monitoring INACTIVE — getBalance() is a stub and HIGGSFIELD_DEFAULT_CREDITS is unset; ' +
          'no balances are known so the <100 generation guard and <200 alerts cannot fire',
        { scanned: businesses.length }
      );
    }
    return { ok: true, monitoring_active: monitoringActive, scanned: businesses.length, seeded, refreshed, alerted };
  }
  internalDispatcher.register('/webhook/check-higgsfield-credits', () => runCheckHiggsfieldCredits());
  app.post('/webhook/check-higgsfield-credits', async (_req, res) => {
    try {
      res.json(await runCheckHiggsfieldCredits());
    } catch (e) {
      apiError(res, 500, 'HF_CREDITS_CHECK_FAILED', e.message);
    }
  });

  const EMAIL_STAGE_LABELS = {
    welcome: 'Welcome Series',
    nurture: 'Nurture',
    abandoned_cart: 'Cart Recovery',
    post_purchase: 'Post-purchase',
    re_engagement: 'Re-engagement',
    win_back: 'Win-back',
  };

  app.get('/api/business/:businessId/email-lifecycle', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId required');
    const safeBiz = encodeURIComponent(businessId);
    try {
      await emailLifecycleService.ensureSequencesForBusiness({
        businessId,
        deps: { sbGet, sbPost, logger },
      });

      const [sequences, runs, retention] = await Promise.all([
        sbGet(
          'email_sequences',
          `business_id=eq.${safeBiz}&select=id,stage,is_active,trigger_event,step_count,cadence_days,created_at&order=stage.asc`
        ).catch(() => []),
        sbGet(
          'email_sequence_runs',
          `business_id=eq.${safeBiz}&select=id,sequence_id,status,send_log,created_at&limit=500`
        ).catch(() => []),
        sbGet(
          'retention_logs',
          `business_id=eq.${safeBiz}&select=sent_at,opened,clicked&order=sent_at.desc&limit=200`
        ).catch(() => []),
      ]);

      const activeRuns = (runs || []).filter((r) => r.status === 'active' || r.status === 'running');
      const sentLogs = (retention || []).length;
      const opens = (retention || []).filter((r) => r.opened).length;
      const clicks = (retention || []).filter((r) => r.clicked).length;

      const mappedSequences = (sequences || []).map((seq) => {
        let cadence = seq.cadence_days;
        if (typeof cadence === 'string') {
          try {
            cadence = JSON.parse(cadence);
          } catch {
            cadence = [];
          }
        }
        if (!Array.isArray(cadence)) cadence = [];
        const steps = cadence.map((day, idx) => ({
          subject: `${EMAIL_STAGE_LABELS[seq.stage] || seq.stage} — step ${idx + 1}`,
          delay: day === 0 ? 'Immediate' : `Day ${day}`,
        }));
        const seqRuns = (runs || []).filter((r) => r.sequence_id === seq.id);
        return {
          id: seq.id,
          stage: seq.stage,
          name: EMAIL_STAGE_LABELS[seq.stage] || seq.stage,
          emails: seq.step_count || steps.length,
          openRate: 0,
          active: seq.is_active !== false,
          status: seq.is_active === false ? 'paused' : 'live',
          steps,
          enrolled: seqRuns.length,
        };
      });

      const chartByDay = {};
      for (const row of retention || []) {
        const day = String(row.sent_at || '').slice(0, 10);
        if (!day) continue;
        if (!chartByDay[day]) chartByDay[day] = { day, opens: 0, clicks: 0 };
        chartByDay[day].opens += row.opened ? 1 : 0;
        chartByDay[day].clicks += row.clicked ? 1 : 0;
      }
      const chart = Object.values(chartByDay)
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(-30);

      return res.json({
        sequences: mappedSequences,
        metrics: {
          active_sequences: mappedSequences.filter((s) => s.active).length,
          subscribers: activeRuns.length,
          open_rate_pct: sentLogs ? Math.round((opens / sentLogs) * 1000) / 10 : null,
          click_rate_pct: sentLogs ? Math.round((clicks / sentLogs) * 1000) / 10 : null,
          emails_sent_30d: sentLogs,
        },
        chart,
        has_data: mappedSequences.length > 0,
      });
    } catch (err) {
      return apiError(res, 500, 'EMAIL_LIFECYCLE_DASHBOARD_FAILED', err.message);
    }
  });

  app.patch('/api/business/:businessId/email-lifecycle/:sequenceId', async (req, res) => {
    const businessId = String(req.params.businessId || '').trim();
    const sequenceId = String(req.params.sequenceId || '').trim();
    const { is_active } = req.body || {};
    if (!businessId || !sequenceId) return apiError(res, 400, 'VALIDATION_ERROR', 'businessId and sequenceId required');
    if (typeof is_active !== 'boolean') return apiError(res, 400, 'VALIDATION_ERROR', 'is_active boolean required');
    try {
      const rows = await sbGet(
        'email_sequences',
        `id=eq.${encodeURIComponent(sequenceId)}&business_id=eq.${encodeURIComponent(businessId)}&select=id&limit=1`
      );
      if (!rows[0]) return apiError(res, 404, 'NOT_FOUND', 'Sequence not found');
      await sbPatch('email_sequences', `id=eq.${sequenceId}`, { is_active });
      return res.json({ ok: true, id: sequenceId, is_active });
    } catch (err) {
      return apiError(res, 500, 'EMAIL_SEQUENCE_PATCH_FAILED', err.message);
    }
  });

  // ─── Autopilot Brain (Week 12) — daily orchestrator + customer brief ─────
  const autopilotBrainService = require('./services/autopilot-brain');

  async function runAutopilotBrainAll() {
    const businesses = await sbGet('businesses', 'is_active=eq.true&select=id&limit=1000').catch(() => []);
    let ran = 0,
      conflicts = 0,
      failed = 0;
    const brainDeps = { sbGet, sbPost, sbPatch, memoryService, logger, sentry: Sentry };
    for (const b of businesses) {
      try {
        const r = await autopilotBrainService.runDaily({ businessId: b.id, deps: brainDeps });
        if (r?.ok) {
          ran += 1;
          conflicts += r.conflicts_resolved || 0;
        } else {
          failed += 1;
        }
      } catch (e) {
        failed += 1;
        logger?.warn?.('/webhook/autopilot-brain-run-all', b.id, 'run failed', { error: e.message });
      }
    }
    // Report failure when EVERY business failed (systemic outage — rotated key,
    // schema drift) so the Inngest cron retries + DLQs instead of silently
    // reporting success. Partial failures stay ok:true (per-business isolation).
    const total = businesses.length;
    return {
      ok: !(failed === total && total > 0),
      businesses: total,
      total,
      failed,
      ran,
      conflicts_resolved: conflicts,
    };
  }
  internalDispatcher.register('/webhook/autopilot-brain-run-all', () => runAutopilotBrainAll());
  app.post('/webhook/autopilot-brain-run-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runAutopilotBrainAll());
    } catch (e) {
      apiError(res, 500, 'AUTOPILOT_BRAIN_RUN_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/autopilot-brain-run', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await autopilotBrainService.runDaily({
        businessId,
        deps: { sbGet, sbPost, sbPatch, memoryService, logger, sentry: Sentry },
      });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'AUTOPILOT_BRAIN_RUN_FAILED', e.message);
    }
  });

  // ─── Ops maintenance — curated Inngest fan-outs (replaces n8n legacy crons) ─
  const opsMaintenance = require('./services/ops-maintenance');
  const SELF_API_BASE =
    process.env.MAROA_API_INTERNAL_URL ||
    process.env.INTERNAL_API_BASE ||
    `http://127.0.0.1:${process.env.PORT || 3000}`;

  const opsDeps = () => ({
    sbGet,
    sbPost,
    sbPatch,
    sbUpsert,
    callClaude,
    sendEmail,
    apiRequest,
    log,
    logError,
    logger,
    storeInsight,
    getEmbedding,
    pineconeUpsert,
    openaiConfigured: !!(clean(process.env.OPENAI_API_KEY) || ''),
    pineconeConfigured: !!(clean(process.env.PINECONE_API_KEY) && clean(process.env.PINECONE_HOST)),
    selfBaseUrl: SELF_API_BASE,
    runSnapshotForBusiness: analyticsRoutes.runSnapshotForBusiness,
    runReportForBusiness: analyticsRoutes.runReportForBusiness,
  });

  async function runOpsDailyHealthAll() {
    return opsMaintenance.runDailyHealthAll(opsDeps());
  }
  async function runOpsWeeklyMaintenanceAll() {
    const result = await opsMaintenance.runWeeklyMaintenanceAll(opsDeps());
    // Refresh the cached Higgsfield preset catalog (migration 087) from the
    // in-code source of truth. Soft-fails so a preset-sync hiccup never fails
    // the weekly maintenance bundle.
    let presets = null;
    try {
      presets = await require('./services/higgsfield/cameraPresets').syncPresetCatalog({
        sbGet,
        sbPost,
        sbPatch,
        logger,
      });
    } catch (e) {
      logger?.warn?.('ops-weekly-maintenance', null, 'preset catalog sync failed', { error: e.message });
    }
    return { ...result, preset_catalog: presets };
  }
  async function runOpsGrowthEngineAll() {
    return opsMaintenance.runGrowthEngineAll(opsDeps());
  }
  async function runOpsAnalyticsSnapshotsAll() {
    return opsMaintenance.runAnalyticsSnapshotsAll(opsDeps());
  }
  async function runOpsMonthlyReportsAll() {
    return opsMaintenance.runMonthlyReportsAll(opsDeps());
  }

  internalDispatcher.register('/webhook/ops-daily-health-all', () => runOpsDailyHealthAll());
  internalDispatcher.register('/webhook/ops-weekly-maintenance-all', () => runOpsWeeklyMaintenanceAll());
  internalDispatcher.register('/webhook/ops-growth-engine-all', () => runOpsGrowthEngineAll());
  internalDispatcher.register('/webhook/ops-analytics-snapshots-all', () => runOpsAnalyticsSnapshotsAll());
  internalDispatcher.register('/webhook/ops-monthly-reports-all', () => runOpsMonthlyReportsAll());

  app.post('/webhook/ops-daily-health-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runOpsDailyHealthAll());
    } catch (e) {
      apiError(res, 500, 'OPS_DAILY_HEALTH_FAILED', e.message);
    }
  });
  app.post('/webhook/ops-weekly-maintenance-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runOpsWeeklyMaintenanceAll());
    } catch (e) {
      apiError(res, 500, 'OPS_WEEKLY_MAINTENANCE_FAILED', e.message);
    }
  });
  app.post('/webhook/ops-growth-engine-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runOpsGrowthEngineAll());
    } catch (e) {
      apiError(res, 500, 'OPS_GROWTH_ENGINE_FAILED', e.message);
    }
  });
  app.post('/webhook/ops-analytics-snapshots-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runOpsAnalyticsSnapshotsAll());
    } catch (e) {
      apiError(res, 500, 'OPS_ANALYTICS_SNAPSHOTS_FAILED', e.message);
    }
  });
  app.post('/webhook/ops-monthly-reports-all', requireWebhookSource, async (req, res) => {
    try {
      res.json(await runOpsMonthlyReportsAll());
    } catch (e) {
      apiError(res, 500, 'OPS_MONTHLY_REPORTS_FAILED', e.message);
    }
  });

  // ─── Higgsfield self-test (probes Cloud + FNF endpoints, no real charges) ──
  // Hits the Higgsfield account using the keys already on Railway and reports
  // exactly which API endpoints work for this account. No credits consumed —
  // uses /agents/balance (free) for Cloud probe and a multipart upload (free)
  // for the upload-contract probe. Soul ID character create is sketched only
  // up to the validation boundary (returns body shape we'd send) so we don't
  // burn credits accidentally.
  app.post('/webhook/higgsfield-self-test', async (req, res) => {
    // Reuse the existing webhook secret auth
    const provided = String(req.headers['x-webhook-secret'] || '');
    if (!provided || provided !== N8N_WEBHOOK_SECRET) {
      return apiError(res, 401, 'UNAUTHORIZED', 'Invalid or missing x-webhook-secret');
    }

    const out = {
      started_at: new Date().toISOString(),
      cloud: { configured: false, balance_probe: null, upload_probe: null },
      fnf: { configured: false, balance_probe: null, upload_probe: null },
      verdict: null,
    };

    const HF_KEY_ID = (process.env.HIGGSFIELD_API_KEY_ID || '').trim();
    const HF_KEY_SECRET = (process.env.HIGGSFIELD_API_KEY_SECRET || '').trim();
    const HF_BEARER = (process.env.HIGGSFIELD_BEARER_TOKEN || '').trim();
    const CLOUD = (process.env.HIGGSFIELD_API_BASE || 'https://platform.higgsfield.ai').trim();
    const FNF = (process.env.HIGGSFIELD_FNF_BASE || 'https://fnf.higgsfield.ai').trim();
    out.cloud.configured = !!(HF_KEY_ID && HF_KEY_SECRET);
    out.fnf.configured = !!HF_BEARER;
    out.cloud.host = CLOUD;
    out.fnf.host = FNF;

    // Tiny valid PNG (8x8 white square) — enough bytes to pass image validation
    const tinyPng = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('0000000d49484452000000080000000808060000', 'hex'),
      Buffer.from('00fcd6720b00000019494441545863fcffff3f0312', 'hex'),
      Buffer.from('00010c0c0c0c0cb0e1f12121e7e7e7000000ffff03', 'hex'),
      Buffer.from('00ff00ff00ff00ff', 'hex'),
      Buffer.from('0000000049454e44ae426082', 'hex'),
    ]);

    async function probeBalance(host, authHeader) {
      return new Promise((resolve) => {
        const u = new URL(`${host}/agents/balance`);
        const req2 = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'GET',
            headers: { Authorization: authHeader },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data.slice(0, 600) }));
          }
        );
        req2.on('error', (e) => resolve({ status: 0, error: e.message }));
        req2.end();
      });
    }

    async function probeUpload(host, authHeader) {
      return new Promise((resolve) => {
        const boundary = `----probe-${Date.now()}`;
        const parts = [
          Buffer.from(`--${boundary}\r\n`),
          Buffer.from(`Content-Disposition: form-data; name="file"; filename="probe.png"\r\n`),
          Buffer.from(`Content-Type: image/png\r\n\r\n`),
          tinyPng,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ];
        const body = Buffer.concat(parts);
        const u = new URL(`${host}/agents/uploads?type=image`);
        const req2 = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': body.length,
            },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data.slice(0, 600) }));
          }
        );
        req2.on('error', (e) => resolve({ status: 0, error: e.message }));
        req2.write(body);
        req2.end();
      });
    }

    // Probe Cloud's actual money path — /higgsfield-ai/soul/standard
    // We send a malformed body (empty JSON) and expect 422 (validation
    // error). If we get 422, the endpoint exists + auth works + we know
    // image generation is reachable. 200 would mean we accidentally got
    // a result. 401/403 = auth issue. 404 = endpoint moved.
    async function probeCloudGeneration(host, authHeader) {
      return new Promise((resolve) => {
        const u = new URL(`${host}/higgsfield-ai/soul/standard`);
        const body = JSON.stringify({}); // intentionally missing 'prompt'
        const req2 = https.request(
          {
            hostname: u.hostname,
            port: 443,
            path: u.pathname,
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data.slice(0, 400) }));
          }
        );
        req2.on('error', (e) => resolve({ status: 0, error: e.message }));
        req2.write(body);
        req2.end();
      });
    }

    // Cloud probes
    if (out.cloud.configured) {
      const cloudAuth = `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`;
      out.cloud.balance_probe = await probeBalance(CLOUD, cloudAuth);
      out.cloud.upload_probe = await probeUpload(CLOUD, cloudAuth);
      out.cloud.generation_probe = await probeCloudGeneration(CLOUD, cloudAuth);
    }

    // FNF probes
    if (out.fnf.configured) {
      const fnfAuth = `Bearer ${HF_BEARER}`;
      out.fnf.balance_probe = await probeBalance(FNF, fnfAuth);
      out.fnf.upload_probe = await probeUpload(FNF, fnfAuth);
    }

    // Verdict — a 422 on Cloud generation is GOOD (endpoint exists, auth ok,
    // body validation working). A 200 here would be unexpected (we sent no
    // prompt). 401/403 = auth issue. 404 = path moved.
    const gen = out.cloud.generation_probe;
    const cloudGenOk = gen && (gen.status === 422 || (gen.status >= 200 && gen.status < 300));
    const cloudUploadOk = out.cloud.upload_probe?.status >= 200 && out.cloud.upload_probe?.status < 300;
    const fnfUploadOk = out.fnf.upload_probe?.status >= 200 && out.fnf.upload_probe?.status < 300;

    if (cloudGenOk && cloudUploadOk) out.verdict = 'cloud_fully_works';
    else if (cloudGenOk)
      out.verdict = 'cloud_generation_works_only'; // good enough — main money path
    else if (cloudUploadOk)
      out.verdict = 'cloud_works'; // legacy verdict
    else if (fnfUploadOk) out.verdict = 'fnf_works';
    else out.verdict = 'neither_works';
    out.completed_at = new Date().toISOString();

    res.json(out);
  });

  app.get('/webhook/social-platforms', async (req, res) => {
    const businessId = req.query?.businessId || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await socialMultiService.listConnectedPlatforms({ businessId, deps: { sbGet } });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'SOCIAL_PLATFORMS_LIST_FAILED', e.message);
    }
  });

  // Real production API clients (wired 2026-05-10)
  const metaMarketingClient = require('./services/meta-marketing');
  const googleAdsApiClient = require('./services/google-ads-api');
  const tiktokMarketingClient = require('./services/tiktok-marketing');
  const metaAdLibraryClient = require('./services/meta-ad-library');

  // Adapter — measurement-health expects metaInsights/googleAdsDiag/tiktokDiag
  // as async ({ businessId }) → { ... }. Each fetches the business row first,
  // then delegates to the real client.
  const metaInsightsAdapter = async ({ businessId }) => {
    const rows = await sbGet(
      'businesses',
      `id=eq.${businessId}&select=meta_access_token,ad_account_id,meta_pixel_id`
    ).catch(() => []);
    const business = rows?.[0];
    if (!business) return null;
    return metaMarketingClient.fetchMeasurementHealth({ business });
  };
  const googleAdsDiagAdapter = async ({ businessId }) => {
    const rows = await sbGet('businesses', `id=eq.${businessId}&select=google_refresh_token,google_customer_id`).catch(
      () => []
    );
    const business = rows?.[0];
    if (!business) return null;
    return googleAdsApiClient.fetchEnhancedConversionsHealth({ business });
  };
  const tiktokDiagAdapter = async ({ businessId }) => {
    const rows = await sbGet('businesses', `id=eq.${businessId}&select=tiktok_access_token,tiktok_advertiser_id`).catch(
      () => []
    );
    const business = rows?.[0];
    if (!business) return null;
    return tiktokMarketingClient.fetchEventsHealth({ business });
  };

  // Adapter — competitor-watch expects metaAdLibraryApi.search({ search_terms,
  // ad_reached_countries, ad_active_status, limit }) and returns array of ads.
  // Our real client uses { search_terms, country, limit } so we wrap.
  const metaAdLibraryAdapter = {
    search: async (opts) => {
      const country = (opts?.ad_reached_countries && opts.ad_reached_countries[0]) || opts?.country || 'US';
      return metaAdLibraryClient.search({
        search_terms: opts.search_terms,
        country,
        limit: opts.limit || 50,
      });
    },
  };

  registerCreativeEngineRoutes({
    app,
    apiError,
    logger,
    sentry: Sentry,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    brandVoice: brandVoiceService,
    higgsfield: higgsfieldForColdStart,
    creativeEngine: creativeEngineService,
    measurementHealth: measurementHealthService,
    competitorWatch: competitorWatchService,
    citationTracker: citationTrackerService,
    metaInsights: metaInsightsAdapter,
    googleAdsDiag: googleAdsDiagAdapter,
    tiktokDiag: tiktokDiagAdapter,
    metaAdLibraryApi: metaAdLibraryAdapter,
    // Marketing Graph mirror — every generated variant becomes a typed
    // `creative` entity so the grounding library can rank future picks by
    // historical performance instead of relying on prompt-time heuristics.
    marketingGraph: _marketingGraph,
  });

  // ─── WF1 hourly auto-run ────────────────────────────────────────────────────
  // Migrated to Inngest 2026-05-08. The in-process setInterval was fragile —
  // reset on every Railway redeploy, no retries, no observability. Now durable.
  //
  // Inngest functions (see services/inngest/functions.js):
  //   wf1-daily-sweep-hourly        → /webhook/wf1-run-daily       (every hour :00)
  //   wf1-measure-fallbacks-hourly  → /webhook/wf1-measure-performance (every hour :30)
  //
  // Kill-switch removed — to disable, pause the function in Inngest dashboard.

  // ─── GDPR: Account & data deletion ───────────────────────────────────────────
  app.post('/api/delete-account', requireAnyUserId, async (req, res) => {
    const userId = req.body.user_id || req.body.userId;
    try {
      if (!isUUID(String(userId || ''))) return apiError(res, 400, 'VALIDATION_ERROR', 'valid user_id required');
      const encUser = encodeURIComponent(userId);
      const businesses = await sbGet('businesses', `user_id=eq.${encUser}&select=id`);
      if (!businesses.length) return apiError(res, 404, 'NOT_FOUND', 'No business found for this user');

      for (const biz of businesses) {
        const bid = encodeURIComponent(biz.id);
        // Child tables keyed by business_id. These MUST be real deletes — the
        // previous code patched business_id to itself (a no-op), so GDPR
        // erasure left every row in place. email_sequence_runs +
        // contact_enrollments are included so lifecycle emails actually stop.
        const tables = [
          'content_concepts',
          'content_assets',
          'content_posts',
          'content_plans',
          'ad_campaigns',
          'contacts',
          'email_sequences',
          'email_sequence_runs',
          'contact_enrollments',
          'generated_content',
          'competitor_insights',
          'retention_logs',
          'brain_conversations',
          'reviews',
          'events',
          'approvals',
          'learning_patterns',
          'usage_logs',
          'daily_stats',
          'win_notifications',
          'business_photos',
          'onboarding_events',
        ];
        for (const table of tables) {
          // Some tables may not exist or have no rows on a given account.
          await sbDelete(table, `business_id=eq.${bid}`).catch(() => {});
        }
      }

      // Anonymize business record (soft delete — preserves referential integrity)
      for (const biz of businesses) {
        await sbPatch('businesses', `id=eq.${biz.id}`, {
          is_active: false,
          email: `deleted-${Date.now()}@deleted.maroa.ai`,
          first_name: '[DELETED]',
          business_name: '[DELETED]',
          target_audience: '',
          brand_tone: '',
          marketing_goal: '',
          meta_access_token: null,
          onboarding_data: null,
          competitors: null,
        });
      }

      // Delete business_profiles + any user-keyed PII (real delete, not no-op).
      await sbDelete('business_profiles', `user_id=eq.${encUser}`).catch(() => {});
      await sbDelete('usage_logs', `user_id=eq.${encUser}`).catch(() => {});

      logger.info('/api/delete-account', userId, 'Account data deleted (GDPR)', { businesses: businesses.length });
      res.json({ success: true, message: 'Your data has been deleted. This action cannot be undone.' });
    } catch (e) {
      logger.error('/api/delete-account', userId, 'Delete failed', { error: e.message });
      apiError(res, 500, 'DELETE_FAILED', 'Failed to delete data. Please contact hello@maroa.ai');
    }
  });

  // ─── Meta Data Deletion Request (GDPR / Platform Terms) ─────────────────────
  const deletionRequestLimiter = expressRateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { error: 'Too many deletion requests. Please try again later or email info@maroa.ai directly.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/webhook/data-deletion-request', deletionRequestLimiter, async (req, res) => {
    try {
      const { name, email, meta_account, reason, requested_at } = req.body || {};

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'Name is required');
      }
      if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'Valid email is required');
      }
      if (name.length > 200 || email.length > 320) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'Input too long');
      }
      if (reason && reason.length > 2000) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'Reason too long');
      }

      const sanitize = (s) => (s || '').toString().replace(/[<>]/g, '').trim().slice(0, 2000);
      const cleanName = sanitize(name);
      const cleanEmail = sanitize(email).toLowerCase();
      const cleanMetaAccount = sanitize(meta_account);
      const cleanReason = sanitize(reason);
      const ipAddress = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
      const userAgent = (req.headers['user-agent'] || 'unknown').toString().slice(0, 500);
      const ts = requested_at || new Date().toISOString();

      // 1. Log to Supabase
      let requestId = 'unknown';
      try {
        const row = await sbPost('data_deletion_requests', {
          name: cleanName,
          email: cleanEmail,
          meta_account: cleanMetaAccount || null,
          reason: cleanReason || null,
          requested_at: ts,
          status: 'pending',
          ip_address: ipAddress,
          user_agent: userAgent,
        });
        requestId = row?.id || requestId;
      } catch (e) {
        logger.warn('/webhook/data-deletion-request', null, 'DB insert failed', { error: e.message });
      }

      // 2. Notify admin
      await sendEmail(
        'info@maroa.ai',
        `[Data Deletion] Request from ${cleanName}`,
        `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="border-bottom:2px solid #e5e5e5;padding-bottom:12px">New Data Deletion Request</h2>
        <p><strong>Request ID:</strong> <code>${requestId}</code></p>
        <p><strong>Name:</strong> ${cleanName}</p>
        <p><strong>Email:</strong> ${cleanEmail}</p>
        <p><strong>Meta Account:</strong> ${cleanMetaAccount || '<em>Not provided</em>'}</p>
        <p><strong>Reason:</strong> ${cleanReason || '<em>Not provided</em>'}</p>
        <p><strong>Requested at:</strong> ${ts}</p>
        <p><strong>IP:</strong> <code>${ipAddress}</code></p>
        <div style="margin-top:20px;padding:16px;background:#fff7ed;border-left:4px solid #f59e0b;border-radius:4px">
          <strong>Action required:</strong> Process within 30 days per Meta Platform Terms and GDPR.
        </div>
      </div>
    `
      ).catch((e) => logger.warn('/webhook/data-deletion-request', null, 'admin email failed', { error: e.message }));

      // 3. Send confirmation to user
      await sendEmail(
        cleanEmail,
        'We received your data deletion request',
        `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2>Request received</h2>
        <p>Hi ${cleanName},</p>
        <p>We've received your data deletion request for maroa.ai. Here's what happens next:</p>
        <ul style="line-height:1.7">
          <li>We will process your request within <strong>30 days</strong>.</li>
          <li>We will permanently delete your account, all content, and all data from connected platforms.</li>
          <li>Once complete, we'll send a confirmation email to this address.</li>
        </ul>
        <p>If you submitted this by mistake, reply to this email or contact <a href="mailto:info@maroa.ai">info@maroa.ai</a>.</p>
        <p style="color:#666;font-size:13px;margin-top:32px;border-top:1px solid #e5e5e5;padding-top:16px">
          Request reference: <code>${requestId}</code><br>maroa.ai · Gjilan, Kosovo
        </p>
      </div>
    `
      ).catch((e) => logger.warn('/webhook/data-deletion-request', null, 'user email failed', { error: e.message }));

      logger.info('/webhook/data-deletion-request', null, 'Deletion request received', {
        email: cleanEmail,
        requestId,
      });
      res.json({
        success: true,
        message: 'Data deletion request received. We will process it within 30 days.',
        request_id: requestId,
      });
    } catch (err) {
      logger.error('/webhook/data-deletion-request', null, 'Deletion request failed', { error: err.message });
      apiError(res, 500, 'DELETE_REQUEST_FAILED', 'Failed to process request. Please email info@maroa.ai directly.');
    }
  });

  // ─── Meta Deauthorize Callback (Facebook Login requirement) ─────────────────
  function parseSignedRequest(signedRequest, appSecret) {
    try {
      const [encodedSig, payload] = signedRequest.split('.');
      if (!encodedSig || !payload) return null;
      const sig = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
      const expectedSig = crypto.createHmac('sha256', appSecret).update(payload).digest();
      if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) return null;
      return data;
    } catch {
      return null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // META COMPLIANCE — carved into routes/meta-compliance.js
  // ═════════════════════════════════════════════════════════════════════════════
  require('./routes/meta-compliance').register({
    app,
    express,
    sbGet,
    sbPost,
    sendEmail,
    apiError,
    logger,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // WAVE 60 — AGENCY-GRADE MASTER PIPELINE (routes/agency-generate.js)
  // Feature-flagged by env.AGENCY_PIPELINE_ENABLED. Off by default so deploy
  // is safe. Flip on once the runbook (docs/runbooks/wave-60-deployment.md)
  // is green.
  // ═════════════════════════════════════════════════════════════════════════════
  // (Universal decision logger _decisionLog is constructed at top of file,
  // just after the sbGet/sbPost/sbPatch helpers, so it's available to
  // every agent factory that wants to mirror into decision_logs.)

  require('./routes/agency-generate').register({
    app,
    env,
    callClaude,
    sbPost,
    metrics: observability && observability.metrics,
    logger,
    aiRateLimit,
    costGuard,
    requireAuthOrWebhookSecret,
    decisionLog: _decisionLog,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // WORKSPACES (multi-tenant) + WAR ROOM FEED — depend on migration 066.
  // Constructed inside a try/catch so a missing migration doesn't crash boot;
  // the route modules themselves bail early if the service is null.
  // ═════════════════════════════════════════════════════════════════════════════
  const _workspaces = (() => {
    try {
      const { makeWorkspacesService } = require('./lib/workspaces');
      return makeWorkspacesService({ sbGet, sbPost, sbPatch });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[workspaces] failed to construct:', e.message);
      return null;
    }
  })();

  const _warRoomFeed = (() => {
    try {
      const { makeWarRoomFeed } = require('./lib/warRoomFeed');
      return makeWarRoomFeed({ sbGet, workspaces: _workspaces });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[warRoomFeed] failed to construct:', e.message);
      return null;
    }
  })();

  require('./routes/workspaces').register({
    app,
    workspaces: _workspaces,
    requireAnyUserId,
    apiError,
    safePublicError,
    log,
  });

  require('./routes/war-room').register({
    app,
    warRoomFeed: _warRoomFeed,
    workspaces: _workspaces,
    decisionLog: _decisionLog,
    requireAnyUserId,
    sbGet,
    sbPatch,
    apiError,
    safePublicError,
    log,
    logger,
    express,
    businessMemory: _businessMemory,
    marketingGraph: _marketingGraph,
  });

  // Claude Computer Use — drives Meta Ads UI for API gaps. Dry-run by
  // default; live runs require COMPUTER_USE_ENABLED=1 AND the runner-worker
  // Docker image deployed (see services/computer-use/README.md).
  const _computerUse = (() => {
    try {
      return require('./services/computer-use').createComputerUseService({
        apiKey: ANTHROPIC_KEY,
        logger,
        sbPost,
        sbPatch,
      });
    } catch (e) {
      logger?.warn?.('computer-use', null, 'init failed', { error: e.message });
      return null;
    }
  })();
  try {
    require('./routes/computer-use').register({
      app,
      computerUse: _computerUse,
      workspaces: _workspaces,
      requireAnyUserId,
      sbGet,
      apiError,
      safePublicError,
      log,
      express,
    });
  } catch (e) {
    logger?.warn?.('computer-use', null, 'route register failed', { error: e.message });
  }

  // Slack /maroa integration — slash commands + Block Kit button callbacks.
  // Verifies every request via HMAC-SHA256 against SLACK_SIGNING_SECRET with
  // a 5-minute replay window. No-op when SLACK_SIGNING_SECRET isn't set —
  // the routes still mount, but every request gets a 401 from the verifier.
  try {
    require('./routes/slack').register({
      app,
      warRoomFeed: _warRoomFeed,
      workspaces: _workspaces,
      decisionLog: _decisionLog,
      sbGet,
      sbPost,
      sbPatch,
      apiError,
      safePublicError,
      log,
      express,
      marketingGraph: _marketingGraph,
      requireAnyUserId,
    });
  } catch (e) {
    logger?.warn?.('slack', null, 'route register failed', { error: e.message });
  }

  // /api/inspiration/save + /api/inspiration/list — captures saves from the
  // browser extension (and any future "save this post" surface) into the
  // Marketing Graph as typed entities.
  try {
    require('./routes/inspiration').register({
      app,
      marketingGraph: _marketingGraph,
      workspaces: _workspaces,
      requireAnyUserId,
      sbGet,
      apiError,
      safePublicError,
      log,
      express,
    });
  } catch (e) {
    logger?.warn?.('inspiration', null, 'route register failed', { error: e.message });
  }

  // /api/tokens — user-issued API tokens (CLI, browser extension, MCP, custom
  // integrations). Secrets stored hashed (PBKDF2-sha512, 100k iterations);
  // full token returned ONCE at creation. Migration 076.
  try {
    require('./routes/api-tokens').register({
      app,
      requireAnyUserId,
      sbGet,
      sbPost,
      sbPatch,
      apiError,
      safePublicError,
      log,
      express,
    });
  } catch (e) {
    logger?.warn?.('api-tokens', null, 'route register failed', { error: e.message });
  }

  // /api/onboarding/* — closes the gap where the dashboard onboarding flow
  // referenced /api/onboarding/save + /api/onboarding/profile/:userId but the
  // handlers were never built. Also exposes /api/onboarding/spark which is
  // the synchronous first-draft endpoint that powers the 60-second magic
  // moment (W4-4).
  try {
    require('./routes/onboarding').register({
      app,
      requireAnyUserId,
      sbGet,
      sbPost,
      sbPatch,
      apiError,
      safePublicError,
      log,
      express,
      // Fetch + Claude-summarize the customer's website on signup, then stamp
      // businesses.website_summary so the brand context can read it (migration
      // 088). Fire-and-forget from the route; soft-fails on any error.
      enrichWebsite: async ({ businessId, url }) => {
        const { enrichFromWebsite } = require('./lib/websiteEnricher');
        const r = await enrichFromWebsite({
          url,
          businessId,
          deps: { callClaude, extractJSON, logger },
        });
        if (r.ok && r.summary) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, {
            website_summary: r.summary,
            website_enriched_at: new Date().toISOString(),
          }).catch(() => {});
        }
        return r;
      },
      // callContentGenerate is plumbed via a loopback HTTP call to
      // /api/content/generate so the route reuses the existing creative
      // pipeline (grounding + critic + cost tracking). 30s budget — past
      // that, the response degrades gracefully to "draft on its way".
      callContentGenerate: async ({ business, theme, industry, tone }) => {
        try {
          const PORT = process.env.PORT || 3000;
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 30_000);
          const r = await fetch(`http://127.0.0.1:${PORT}/api/content/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': process.env.N8N_WEBHOOK_SECRET || '',
            },
            body: JSON.stringify({
              business_id: business.id,
              content_theme: theme,
              industry,
              brand_tone: tone,
            }),
            signal: ctl.signal,
          }).finally(() => clearTimeout(to));
          if (!r.ok) return null;
          return await r.json();
        } catch {
          return null;
        }
      },
    });
  } catch (e) {
    logger?.warn?.('onboarding', null, 'route register failed', { error: e.message });
  }

  // Internal webhook to trigger the weekly-scorecard batch orchestrator
  // (Anthropic Batches API → 50% list price). Webhook-secret gated so only
  // Inngest's cron (or an operator with the secret) can invoke it.
  app.post('/webhook/weekly-scorecard-batch', requireAuthOrWebhookSecret, requireWebhookSource, async (req, res) => {
    try {
      if (!ANTHROPIC_KEY) {
        return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Anthropic key not configured');
      }
      const businessIds = Array.isArray(req.body?.businessIds) ? req.body.businessIds : null;
      if (!businessIds || businessIds.length === 0) {
        return apiError(res, 400, 'VALIDATION_ERROR', 'businessIds[] required');
      }
      const orchestrator = require('./services/weekly-scorecard/batchOrchestrator').createBatchOrchestrator({
        sbGet,
        sbPost,
        sbPatch,
        sendEmail,
        extractJSON,
        apiKey: ANTHROPIC_KEY,
        logger,
        Sentry,
      });
      res.json({ received: true, count: businessIds.length });
      orchestrator
        .runWeeklyBatch({ businessIds })
        .then((r) => logger.info('/webhook/weekly-scorecard-batch', null, 'batch finished', r))
        .catch((e) => logger.error('/webhook/weekly-scorecard-batch', null, 'batch failed', { error: e.message }));
    } catch (err) {
      logger.error('/webhook/weekly-scorecard-batch', null, 'init failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  // ─── 404 ──────────────────────────────────────────────────────────────────────
  app.use((req, res) => apiError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));

  app.use((err, req, res, next) => {
    if (err && String(err.message || '').includes('CORS')) {
      return apiError(res, 403, 'CORS_FORBIDDEN', 'Origin not allowed');
    }
    logger.error(req.path || 'unknown', null, 'Unhandled error', err, { request_id: req.requestId });
    if (res.headersSent) return next(err);
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    const code = typeof err.code === 'string' && err.code ? err.code : 'INTERNAL_ERROR';
    const msg =
      process.env.NODE_ENV === 'production' && status >= 500
        ? 'Internal server error'
        : err.message || 'Internal server error';
    return apiError(res, status, code, msg);
  });

  // ─── /webhook/wf-content-performance-feedback (Inngest target) ──────────────
  async function runWfContentPerformanceFeedback(body) {
    const { contentId, businessId } = body || {};
    if (!contentId || !businessId) {
      const e = new Error('contentId and businessId required');
      e.status = 400;
      throw e;
    }
    const bizRows = await sbGet(
      'businesses',
      `id=eq.${encodeURIComponent(businessId)}&select=meta_access_token,meta_access_token_enc,facebook_page_id`
    );
    const biz = bizRows[0];
    if (!biz) {
      const e = new Error('business not found');
      e.status = 404;
      throw e;
    }
    const oauthCrypto = require('./lib/oauthCrypto');
    const token = oauthCrypto.readToken(biz, 'meta_access_token');
    const pageId = biz.facebook_page_id;
    if (!token || !pageId) {
      return { ok: false, reason: 'meta token or page id missing — skipping' };
    }
    const postsResp = await apiRequest(
      'GET',
      `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/posts?fields=id,message,insights.metric(post_impressions,post_engaged_users)&limit=5&access_token=${encodeURIComponent(token)}`,
      {}
    );
    const posts = postsResp.body?.data || [];
    let totalImpressions = 0,
      totalEngagement = 0;
    for (const p of posts) {
      const metrics = p.insights?.data || [];
      for (const m of metrics) {
        if (m.name === 'post_impressions') totalImpressions += m.values?.[0]?.value || 0;
        if (m.name === 'post_engaged_users') totalEngagement += m.values?.[0]?.value || 0;
      }
    }
    const performanceScore =
      totalImpressions > 0 ? Math.min(10, Math.round((totalEngagement / totalImpressions) * 100)) : 0;
    await sbPatch('generated_content', `id=eq.${encodeURIComponent(contentId)}`, {
      performance_score: performanceScore,
      total_reach: totalImpressions,
    });
    return { ok: true, contentId, performance_score: performanceScore, total_reach: totalImpressions };
  }
  internalDispatcher.register('/webhook/wf-content-performance-feedback', (body) =>
    runWfContentPerformanceFeedback(body || {})
  );
  app.post('/webhook/wf-content-performance-feedback', async (req, res) => {
    try {
      res.json(await runWfContentPerformanceFeedback(req.body || {}));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) {
        logger.error('/webhook/wf-content-performance-feedback', req.body?.businessId, e.message);
      }
      return apiError(res, status, status === 400 ? 'VALIDATION_ERROR' : 'FEEDBACK_FAILED', e.message);
    }
  });

  console.log('[boot] all routes registered — server fully ready', {
    duration_ms: Date.now() - _routeLoadStartedAt,
  });
});

async function gracefulShutdown(signal) {
  log('shutdown', `Received ${signal}, beginning graceful shutdown`);
  const deadlineMs = 25000;
  const deadline = Date.now() + deadlineMs;

  // Arm the 30s deadman switch IMMEDIATELY so we never hang indefinitely
  armShutdownDeadman();

  // 1. Stop accepting new requests immediately. server.close() lets
  //    in-flight requests finish before invoking the callback.
  server.close((err) => {
    if (err) log('shutdown', `server.close error: ${err.message}`);
    else log('shutdown', 'HTTP server closed');
  });

  // 1b. Drop idle keep-alive connections so the server can actually close
  //     once active requests finish.
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
    log('shutdown', 'Idle keep-alive connections closed');
  }

  // 2. Close every SSE connection so clients reconnect against the
  //    next instance instead of hanging until TCP timeout.
  try {
    for (const res of _sseClients) {
      try {
        res.write('event: shutdown\ndata: server-rolling\n\n');
        res.end();
      } catch {
        /* client gone */
      }
    }
    _sseClients.clear();
    log('shutdown', 'SSE clients drained');
  } catch (e) {
    log('shutdown', `SSE drain error: ${e?.message}`);
  }

  // 2b. Force-close keep-alive sockets. Browsers + load balancers keep
  //     persistent connections open which makes server.close() hang
  //     indefinitely (waits for ALL in-flight responses). We let
  //     in-flight responses finish naturally but tell sockets not to
  //     accept new requests, then destroy any that are still idle.
  //
  // Without this, "graceful" shutdown was actually a 30s hard-kill on
  // every deploy (the deadman would fire). Now: typically <2s clean exit.
  try {
    for (const socket of _openSockets) {
      try {
        // Setting keepAlive false + destroying on next idle naturally
        // closes the connection without aborting in-flight requests.
        socket.unref?.();
        socket.end?.();
      } catch {
        /* socket already torn down */
      }
    }
    // After 5s, hard-destroy anything that hasn't closed itself.
    setTimeout(() => {
      for (const socket of _openSockets) {
        try {
          socket.destroy();
        } catch {
          /* gone */
        }
      }
      _openSockets.clear();
    }, 5000).unref();
    log('shutdown', `Initiated close on ${_openSockets.size} keep-alive sockets`);
  } catch (e) {
    log('shutdown', `socket drain error: ${e?.message}`);
  }

  // 3. Flush Sentry events so the error trail isn't lost on rolling
  //    deploys. Sentry's `close(timeoutMs)` returns true if drained.
  try {
    if (process.env.SENTRY_DSN && typeof Sentry?.close === 'function') {
      const remaining = Math.max(2000, deadline - Date.now() - 2000);
      await Promise.race([Sentry.close(remaining), new Promise((r) => setTimeout(r, remaining + 500))]);
      log('shutdown', 'Sentry flushed');
    }
  } catch (e) {
    log('shutdown', `Sentry flush error: ${e?.message}`);
  }

  // 4. Allow Inngest in-flight steps to finish — Inngest functions write
  //    state via step.run() so technically they survive a crash, but
  //    letting them finish cleanly avoids unnecessary retries on
  //    every redeploy.
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining > 0) {
    log('shutdown', `Waiting up to ${remaining}ms for in-flight work`);
    await new Promise((r) => setTimeout(r, Math.min(remaining, 3000)));
  }

  // 5. OpenTelemetry — flush any pending traces.
  try {
    await require('./lib/otel').shutdown();
  } catch (e) {
    log('shutdown', `OTel shutdown error: ${e?.message}`);
  }

  log('shutdown', `Graceful shutdown complete — exiting after ${signal}`);
  process.exit(0);
}

// Hard-stop hatch: if anything in gracefulShutdown hangs past 30s,
// force-exit. Without .unref() this would keep the process alive.
function armShutdownDeadman() {
  setTimeout(() => {
    log('shutdown', 'Forced exit after 30s deadline');
    process.exit(1);
  }, 30000).unref();
}

let _shuttingDown = false;

function beginFatalShutdown(signal, err) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  if (err && process.env.SENTRY_DSN) Sentry.captureException(err);
  armShutdownDeadman();
  gracefulShutdown(signal).catch(() => process.exit(1));
}

process.on('unhandledRejection', (reason) => {
  // Log + capture but do NOT shut down. A single stray rejection in any
  // background path (cron, SSE write, fire-and-forget loopback) must not drop
  // every in-flight customer request on the instance. Only a genuine
  // uncaughtException (corrupt process state) warrants a graceful restart.
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('/process', null, 'Unhandled Promise Rejection (continuing)', {
    reason: String(reason),
    stack: err.stack,
  });
  if (process.env.SENTRY_DSN) {
    try {
      Sentry.captureException(err);
    } catch {
      /* ignore */
    }
  }
});

process.on('uncaughtException', (err) => {
  logger.error('/process', null, 'Uncaught Exception — graceful shutdown', {
    error: err.message,
    stack: err.stack,
  });
  beginFatalShutdown('uncaughtException', err);
});

process.on('SIGTERM', () => {
  armShutdownDeadman();
  gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  armShutdownDeadman();
  gracefulShutdown('SIGINT');
});
