// server.js — Maroa.ai Webhook API Server v2.0
// Layer 1: Execution  | Layer 2: Intelligence  | Layer 3: Learning
// The AI does everything forever and gets smarter every week.

'use strict';
const express  = require('express');
const cors     = require('cors');
const expressRateLimit = require('express-rate-limit');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const { randomUUID: uuidv4 } = require('crypto');
const { validate } = require('./lib/validators');
const { checkRateLimit } = require('./lib/rateLimit');
const planGate = require('./middleware/planGate');
const { checkPlanLimit } = require('./middleware/planLimits');
const paddle = require('./services/paddle');

const logger = {
  info: (route, businessId, message, data = {}) => {
    console.log(JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      route,
      business_id: businessId,
      message,
      ...data
    }));
  },
  error: (route, businessId, message, error, data = {}) => {
    console.error(JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      route,
      business_id: businessId,
      message,
      error: error?.message || error,
      stack: error?.stack,
      ...data
    }));
  },
  warn: (route, businessId, message, data = {}) => {
    console.warn(JSON.stringify({
      level: 'warn',
      timestamp: new Date().toISOString(),
      route,
      business_id: businessId,
      message,
      ...data
    }));
  }
};

function apiError(res, status, code, message, details = null) {
  return res.status(status).json({
    error: {
      code,
      message,
      details,
      timestamp: new Date().toISOString()
    }
  });
}

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'https://maroa-ai-marketing-automator.vercel.app',
    'https://maroa-frontend.vercel.app',
    'https://maroa.ai',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey', 'x-orchestrator-secret', 'x-webhook-secret', 'paddle-signature'],
  credentials: true
};
app.use(cors(corsOptions));
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
        request_id: req.requestId
      });
    }
  });
  next();
});

const paddleWebhookRawBody = express.raw({ type: 'application/json' });
app.post('/webhook/paddle-webhook', paddleWebhookRawBody, paddleWebhookHandler);

app.use(express.json({ limit: '10mb' }));

function requireN8nWebhookSecret(req, res, next) {
  const pathOnly = req.originalUrl.split('?')[0];
  if (pathOnly === '/webhook/paddle-webhook') return next();
  if (pathOnly === '/webhook/email-approve') return next();
  if (pathOnly === '/webhook/dashboard-events') return next();
  if (req.method === 'OPTIONS') return next();
  if (!N8N_WEBHOOK_SECRET) {
    return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'N8N_WEBHOOK_SECRET not configured');
  }
  const provided = clean(String(req.headers['x-webhook-secret'] || ''));
  if (provided !== N8N_WEBHOOK_SECRET) {
    return apiError(res, 401, 'UNAUTHORIZED', 'Invalid or missing x-webhook-secret');
  }
  next();
}

app.use('/webhook', requireN8nWebhookSecret);

const aiLimitExpress = expressRateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests — please wait' }
});

function aiRateLimit(req, res, next) {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const id = String(req.body?.userId || req.body?.business_id || req.ip || 'anon');
    return checkRateLimit(id)
      .then((out) => {
        if (!out.success) {
          return apiError(res, 429, 'RATE_LIMITED', 'Too many requests — please wait 1 minute');
        }
        next();
      })
      .catch((e) => {
        logger.warn(req.path, null, 'Redis rate limit check failed', { request_id: req.requestId, error: e.message });
        next();
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
app.use('/api/laun ompts', requireValidUserId);
app.use('/api/signup-cro/analyze', requireValidUserId);

// ─── Config ───────────────────────────────────────────────────────────────────
const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL        = clean(process.env.SUPABASE_URL)        || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_KEY        = clean(process.env.SUPABASE_KEY)        || '';
const ANTHROPIC_KEY       = clean(process.env.ANTHROPIC_KEY) || clean(process.env.ANTHROPIC_API_KEY) || '';
const SERPAPI_KEY         = clean(process.env.SERPAPI_KEY)         || '';
const REPLICATE_API_KEY   = clean(process.env.REPLICATE_API_KEY)   || '';
const PEXELS_API_KEY      = clean(process.env.PEXELS_API_KEY)      || '';
const RESEND_API_KEY      = clean(process.env.RESEND_API_KEY)      || '';
const FROM_EMAIL          = clean(process.env.FROM_EMAIL)          || 'onboarding@resend.dev';
const PORT                = process.env.PORT                        || 3000;
// Sprint 5 — Brand Memory + Reviews
const OPENAI_API_KEY      = clean(process.env.OPENAI_API_KEY)      || '';
const PINECONE_API_KEY    = clean(process.env.PINECONE_API_KEY)    || '';
const PINECONE_HOST       = clean(process.env.PINECONE_HOST)       || ''; // full index host URL
// Sprint 6 — Video Generation
const RUNWAY_API_KEY      = clean(process.env.RUNWAY_API_KEY)      || '';
// Smart Image System
const GOOGLE_AI_API_KEY   = clean(process.env.GOOGLE_AI_API_KEY)   || '';
// Twilio WhatsApp
const TWILIO_ACCOUNT_SID  = clean(process.env.TWILIO_ACCOUNT_SID)  || '';
const TWILIO_AUTH_TOKEN   = clean(process.env.TWILIO_AUTH_TOKEN)   || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM     || 'whatsapp:+14155238886';
// Paddle Billing
const PADDLE_WEBHOOK_SECRET = clean(process.env.PADDLE_WEBHOOK_SECRET) || '';
const PADDLE_STARTER_PRICE = clean(process.env.PADDLE_STARTER_PRICE_ID) || '';
const PADDLE_GROWTH_PRICE  = clean(process.env.PADDLE_GROWTH_PRICE_ID) || '';
const PADDLE_AGENCY_PRICE  = clean(process.env.PADDLE_AGENCY_PRICE_ID) || '';
const ORCHESTRATOR_SECRET  = clean(process.env.ORCHESTRATOR_SECRET)   || '';
const N8N_WEBHOOK_SECRET   = clean(process.env.N8N_WEBHOOK_SECRET)    || '';

// Paddle client initialized in services/paddle.js

function isInternalMaroaWebhookUrl(urlString) {
  try {
    const u = new URL(urlString);
    const p = u.pathname;
    if (p === '/webhook/paddle-webhook') return false;
    if (!p.startsWith('/webhook/')) return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === 'maroa-api-production.up.railway.app';
  } catch {
    return false;
  }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function apiRequest(method, url, headers = {}, body = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u        = new URL(url);
    const bodyStr  = body ? JSON.stringify(body) : null;
    const proto    = u.protocol === 'https:' ? https : http;
    const extra    = (N8N_WEBHOOK_SECRET && isInternalMaroaWebhookUrl(url))
      ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET }
      : {};
    const opts = {
      hostname : u.hostname,
      port     : u.port || (u.protocol === 'https:' ? 443 : 80),
      path     : u.pathname + u.search,
      method,
      headers  : { 'Content-Type': 'application/json', ...extra, ...headers }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = proto.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
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
const sbH = () => ({ 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` });

async function sbGet(table, query = '') {
  const r = await apiRequest('GET', `${SUPABASE_URL}/rest/v1/${table}?${query}`, sbH());
  if (r.status !== 200) throw new Error(`sbGet ${table}: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return Array.isArray(r.body) ? r.body : [];
}

async function sbPost(table, data) {
  const r = await apiRequest('POST', `${SUPABASE_URL}/rest/v1/${table}`,
    { ...sbH(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, data);
  if (![200, 201].includes(r.status)) throw new Error(`sbPost ${table}: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

async function sbPatch(table, filter, data) {
  const r = await apiRequest('PATCH', `${SUPABASE_URL}/rest/v1/${table}?${filter}`,
    { ...sbH(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, data);
  if (![200, 201, 204].includes(r.status)) throw new Error(`sbPatch ${table}: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return true;
}

const PLAN_TOKEN_BUDGETS = {
  starter: { daily_tokens: 50000, max_tokens_per_call: 1000, calls_per_day: 30 },
  growth: { daily_tokens: 200000, max_tokens_per_call: 2000, calls_per_day: 90 },
  agency: { daily_tokens: 500000, max_tokens_per_call: 4000, calls_per_day: 150 }
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
        headers: { ...sbH(), Prefer: 'count=exact' }
      },
      res => {
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
  try {
    let rows = await sbGet('businesses', `id=eq.${businessId}&select=plan,user_id`).catch(() => []);
    if (!rows.length) rows = await sbGet('businesses', `user_id=eq.${businessId}&select=plan,user_id`).catch(() => []);
    if (!rows.length) return { allowed: true, maxTokensPerCall: 2000 };
    const tier = normalizePlanTier(rows[0]?.plan);
    const budget = PLAN_TOKEN_BUDGETS[tier] || PLAN_TOKEN_BUDGETS.starter;
    const logUid = rows[0]?.user_id || businessId;
    const since = new Date(Date.now() - 86400000).toISOString();
    const count = await sbCountExact(
      'orchestration_logs',
      `user_id=eq.${logUid}&created_at=gte.${encodeURIComponent(since)}&task=eq.ai_call`
    );
    if (count >= budget.calls_per_day) {
      return {
        allowed: false,
        reason: `Daily limit of ${budget.calls_per_day} AI calls reached for ${tier} plan`,
        maxTokensPerCall: budget.max_tokens_per_call
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
    return { model: 'claude-opus-4-5', max_tokens: 4000 };
  }
  if (['social_post', 'email', 'campaign', 'paid_ad', 'sales_pitch'].includes(taskType)) {
    return { model: 'claude-sonnet-4-5', max_tokens: 2000 };
  }
  if (['caption', 'idea', 'hashtags', 'short_copy', 'community_post'].includes(taskType)) {
    return { model: 'claude-haiku-4-5', max_tokens: 1000 };
  }
  return { model: 'claude-sonnet-4-5', max_tokens: 2000 };
}

/**
 * Call Claude. Backward compatible:
 * - callClaude(prompt, 'claude-opus-4-5', 3000) — explicit model
 * - callClaude(prompt, 'strategy', 1500) — taskType + optional max override
 * - callClaude(prompt, 'social_post', undefined, { returnRaw: true, system: '...' })
 */
async function callClaude(prompt, taskTypeOrModel = 'social_post', maxTokensOverride, extra = {}) {
  if (maxTokensOverride !== undefined && typeof maxTokensOverride === 'object' && maxTokensOverride !== null && !Array.isArray(maxTokensOverride)) {
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
    const b = await checkTokenBudgetForBusiness(extra.businessId);
    if (!b.allowed) {
      const e = new Error(b.reason || 'AI budget exceeded');
      e.status = 402;
      e.code = 'AI_BUDGET_EXCEEDED';
      throw e;
    }
    maxTokens = Math.min(maxTokens, b.maxTokensPerCall || maxTokens);
  }

  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (extra.system) body.system = extra.system;

  const retries = extra.retries !== undefined ? extra.retries : 3;
  let attempt = 0;
  let lastErr;

  while (attempt < retries) {
    attempt++;
    try {
      const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
        'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'
      }, body);

      if (r.status === 200) {
        if (extra.businessId && !extra.skipUsageLog) {
          setImmediate(() => {
            sbGet('businesses', `id=eq.${extra.businessId}&select=user_id`)
              .then(rows => {
                const uid = rows[0]?.user_id || extra.businessId;
                return recordOrchestrationTaskRun(uid, 'ai_call');
              })
              .catch(() => {});
          });
        }
        const raw = r.body?.content?.[0]?.text || '';
        if (extra.returnRaw) return raw;
        return extractJSON(raw) || { _raw: raw };
      }

      const retryable = r.status === 429 || r.status >= 500;
      if (retryable && attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('/claude', extra.businessId || null, `Claude retry ${attempt}/${retries}`, {
          status: r.status,
          delay_ms: delay
        });
        await new Promise(res => setTimeout(res, delay));
        continue;
      }

      const err = new Error(`Claude ${model}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      err.status = r.status;
      throw err;
    } catch (e) {
      lastErr = e;
      const msg = e?.message || '';
      const netRetry = attempt < retries && (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('socket'));
      if (netRetry) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('/claude', extra.businessId || null, `Claude network retry ${attempt}/${retries}`, { error: msg, delay_ms: delay });
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Claude request failed');
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
    const bestThemes = (top || []).map(c => c.content_theme).filter(Boolean);
    const worstThemes = (worst || []).map(c => c.content_theme).filter(Boolean);
    let s = '';
    if (bestThemes.length) s += `BEST PERFORMING THEMES (from recent scored content): ${[...new Set(bestThemes)].join(', ')} — lean into these.\n`;
    if (worstThemes.length) s += `WORST PERFORMING THEMES: ${[...new Set(worstThemes)].join(', ')} — avoid repeating these angles.\n`;
    return s.trim() ? s : '';
  } catch {
    return '';
  }
}

async function checkOrchestrationIdempotency(userId, taskName, windowMs = 3600000) {
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const encSince = encodeURIComponent(since);
    const rows = await sbGet(
      'orchestration_logs',
      `user_id=eq.${userId}&task=eq.${encodeURIComponent(taskName)}&created_at=gte.${encSince}&limit=1&select=id`
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function recordOrchestrationTaskRun(userId, taskName, report = '') {
  try {
    await sbPost('orchestration_logs', {
      user_id: userId,
      task: taskName,
      report: report || taskName,
      tasks_planned: [],
      tasks_executed: []
    });
  } catch {}
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
        html: `<p>Endpoint <strong>${endpoint}</strong> has recorded 3+ errors in 24h for client <code>${userId}</code>. Check Railway logs.</p>`
      }
    ).catch(() => {});
  } catch {}
}

// ─── Universal JSON extractor — handles markdown fences, mixed text, arrays ─
function extractJSON(text) {
  if (!text) return null;
  // 1. Direct parse
  try { return JSON.parse(text); } catch {}
  // 2. Strip ALL markdown code fences (global, not just start/end)
  const cleaned = text.replace(/```(?:json|javascript|js)?\s*/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // 3. Find JSON array (greedy — outermost brackets)
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  // 4. Find JSON object (greedy — outermost braces)
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  // 5. Repair truncated JSON array — find last complete object and close the array
  const arrStart = cleaned.indexOf('[');
  if (arrStart !== -1) {
    let truncated = cleaned.slice(arrStart);
    // Find the last complete "}" and close the array there
    const lastBrace = truncated.lastIndexOf('}');
    if (lastBrace > 0) {
      const repaired = truncated.slice(0, lastBrace + 1) + ']';
      try { return JSON.parse(repaired); } catch {}
    }
  }
  return null;
}

// ─── OpenAI embedding helper ─────────────────────────────────────────────────
async function getEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const r = await apiRequest('POST', 'https://api.openai.com/v1/embeddings',
    { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    { model: 'text-embedding-3-small', input: text.slice(0, 8000) });
  if (r.status !== 200) throw new Error(`OpenAI embed: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body?.data?.[0]?.embedding || [];
}

// ─── Pinecone helpers ─────────────────────────────────────────────────────────
async function pineconeUpsert(vectors) {
  if (!PINECONE_API_KEY || !PINECONE_HOST) throw new Error('Pinecone not configured');
  const r = await apiRequest('POST', `${PINECONE_HOST}/vectors/upsert`,
    { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
    { vectors });
  if (![200,201].includes(r.status)) throw new Error(`Pinecone upsert: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body;
}

async function pineconeQuery(vector, filter = {}, topK = 3) {
  if (!PINECONE_API_KEY || !PINECONE_HOST) return { matches: [] };
  const r = await apiRequest('POST', `${PINECONE_HOST}/query`,
    { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
    { vector, filter, topK, includeMetadata: true });
  if (r.status !== 200) return { matches: [] };
  return r.body;
}

// ─── Brand memory context helper ─────────────────────────────────────────────
// Returns a prompt prefix string like "Here are examples…\n---\n" or '' if none
async function getBrandExamples(business_id, content_type, topic) {
  try {
    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST) return '';
    const vector = await getEmbedding(topic);
    const result = await pineconeQuery(vector, { businessId: { $eq: business_id }, contentType: { $eq: content_type } }, 3);
    const matches = (result.matches || []).filter(m => m.score > 0.7 && m.metadata?.text);
    if (!matches.length) return '';
    const examples = matches.map(m => m.metadata.text).join('\n---\n');
    return `Here are examples of this business's best-performing content — match this exact voice and style:\n${examples}\n\nNow write new content:\n`;
  } catch { return ''; }
}

// ─── SerpAPI helper ───────────────────────────────────────────────────────────
async function serpSearch(query, num = 5) {
  try {
    const r = await apiRequest('GET',
      `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_KEY}&engine=google&num=${num}`,
      {});
    if (r.status !== 200) return [];
    const results = r.body?.organic_results || [];
    return results.slice(0, num).map(res => ({
      title   : res.title || '',
      link    : res.link  || '',
      snippet : res.snippet || ''
    }));
  } catch { return []; }
}

const createHiggsfieldService = require('./services/higgsfield');
const higgsfieldAI = createHiggsfieldService({
  apiRequest,
  serpSearch,
  logger,
  extractJSON,
  sbGet,
  sbPost,
  ANTHROPIC_KEY,
  SERPAPI_KEY,
  SUPABASE_URL,
  SUPABASE_KEY
});

// ─── Workflow #1 — Daily Content Engine ──────────────────────────────────────
// Factory wires: context bundle, strategic decision, platform generation,
// quality gate, guardrails, publisher, learning loop, daily orchestrator.
// Strategic framework is imported from services/prompts/foundation.js (auto-
// generated from the frontend's canonical src/lib/prompts/foundation.ts via
// scripts/sync_foundation.mjs — do not hand-edit the generated files).
const createWf1 = require('./services/wf1');
let countryIntelligenceMod = null;
try { countryIntelligenceMod = require('./services/countryIntelligence'); } catch { /* optional */ }
const wf1 = createWf1({
  sbGet, sbPost, sbPatch,
  callClaude, extractJSON,
  apiRequest, serpSearch,
  countryIntelligence: countryIntelligenceMod,
  checkOrchestrationIdempotency,
  recordOrchestrationTaskRun,
  logger,
});
const { registerWf1Routes } = require('./services/wf1/registerRoutes');

// ─── Save image to Supabase Storage (permanent URL) ──────────────────────────
async function saveImageToSupabase(imageUrl, businessId) {
  if (!imageUrl || !imageUrl.startsWith('http')) return imageUrl;
  try {
    // Download image as binary buffer
    const imgBuf = await new Promise((resolve, reject) => {
      const u = new URL(imageUrl);
      const proto = u.protocol === 'https:' ? https : http;
      proto.get(imageUrl, { headers: { 'Accept': '*/*' } }, res => {
        // Follow redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          return saveImageToSupabase(res.headers.location, businessId).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // Detect content type from URL or default to jpeg
    const ext = imageUrl.includes('.webp') ? 'webp' : imageUrl.includes('.png') ? 'png' : 'jpg';
    const contentType = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
    const fileName = `${businessId}/${Date.now()}.${ext}`;

    // Upload to Supabase Storage via REST API
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/business-photos/${fileName}`;
    const uploadResp = await new Promise((resolve, reject) => {
      const u = new URL(uploadUrl);
      const req = https.request({
        hostname: u.hostname, port: 443, path: u.pathname,
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': contentType,
          'Content-Length': imgBuf.length,
          'x-upsert': 'false'
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
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
  const r = await apiRequest('POST', 'https://api.ideogram.ai/generate',
    { 'Api-Key': IDEOGRAM_API_KEY, 'Content-Type': 'application/json' },
    { image_request: { prompt: (prompt + '. No text, no words, no watermarks.').slice(0, 1200), negative_prompt: IMAGE_NEGATIVE_PROMPT, model: 'V_2_TURBO', magic_prompt_option: 'AUTO', style_type: 'REALISTIC', aspect_ratio: aspectMap[aspectRatio] || 'ASPECT_1_1' } });
  if (r.status !== 200) throw new Error(`Ideogram: ${r.status}`);
  const url = r.body?.data?.[0]?.url;
  if (!url) throw new Error('No image from Ideogram');
  return url;
}

// ── Model: Flux 1.1 Pro via Replicate ────────────────────────────────────────
async function generateWithFlux(prompt) {
  if (!REPLICATE_API_KEY) throw new Error('REPLICATE_API_KEY not set');
  const pred = await apiRequest('POST', 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
    { 'Authorization': `Bearer ${REPLICATE_API_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
    { input: { prompt: prompt.slice(0, 500), negative_prompt: IMAGE_NEGATIVE_PROMPT, aspect_ratio: '1:1', output_format: 'webp', safety_tolerance: 2 } });
  if (pred.status === 200 || pred.status === 201) {
    let output = pred.body?.output;
    if (!output && pred.body?.id) {
      const predId = pred.body.id;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const poll = await apiRequest('GET', `https://api.replicate.com/v1/predictions/${predId}`,
          { 'Authorization': `Bearer ${REPLICATE_API_KEY}` });
        if (poll.body?.status === 'succeeded') { output = poll.body.output; break; }
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
  const r = await apiRequest('POST', 'https://api.openai.com/v1/images/generations',
    { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    { model: 'dall-e-3', prompt: (prompt + '. Professional marketing image, clean composition, no text.').slice(0, 4000), n: 1, size: '1024x1024', quality: 'hd', style: 'natural' });
  if (r.status !== 200) throw new Error(`DALL-E 3: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  const url = r.body?.data?.[0]?.url;
  if (!url) throw new Error('No URL in DALL-E 3 response');
  return url;
}

// ── Model: Gemini image generation ───────────────────────────────────────────
async function generateWithGemini(prompt, businessId) {
  if (!GOOGLE_AI_API_KEY) throw new Error('GOOGLE_AI_API_KEY not set');
  const fullPrompt = prompt + '. Professional marketing image, photorealistic, high quality, no text overlays, clean composition.';
  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  };
  // Try gemini-2.0-flash-exp (image generation capable model)
  const r = await apiRequest('POST',
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${GOOGLE_AI_API_KEY}`,
    { 'Content-Type': 'application/json' }, body);
  if (r.status !== 200) throw new Error(`Gemini: ${r.status}`);
  const parts = r.body?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData);
  if (!imgPart?.inlineData?.data) throw new Error('No image in Gemini response');
  // Upload base64 buffer to Supabase directly
  const buf = Buffer.from(imgPart.inlineData.data, 'base64');
  const mime = imgPart.inlineData.mimeType || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const fileName = `${businessId}/${Date.now()}_gemini.${ext}`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/business-photos/${fileName}`;
  const uploadResp = await new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': mime, 'Content-Length': buf.length, 'x-upsert': 'false' }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.write(buf); req.end();
  });
  if (uploadResp.status >= 200 && uploadResp.status < 300) {
    return `${SUPABASE_URL}/storage/v1/object/public/business-photos/${fileName}`;
  }
  throw new Error(`Gemini upload failed: ${uploadResp.status}`);
}

// ── Model: Pexels stock photo ────────────────────────────────────────────────
async function generateWithPexels(query) {
  if (!PEXELS_API_KEY) throw new Error('PEXELS_API_KEY not set');
  const r = await apiRequest('GET',
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=square`,
    { 'Authorization': PEXELS_API_KEY });
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
    if (['ad_creative','hero_image','product_photo'].includes(contentType))
      return ['ideogram','gemini','flux','dalle3','pexels'];
    return ['ideogram','gemini','flux','pexels'];
  }
  if (plan === 'growth') {
    return ['ideogram','flux','gemini','pexels'];
  }
  // starter — still gets AI images, just fewer model options
  return ['flux','gemini','pexels'];
}

// ── Business-type image style rules ─────────────────────────────────────────
const IMAGE_STYLE_RULES = {
  fitness:    { lighting: 'dramatic side lighting with rim light', mood: 'intense and aspirational', aesthetic: 'Nike campaign sports photography', colors: 'high contrast warm tones with deep shadows', extra: 'motion blur or frozen action, strong shadows, athletic energy' },
  restaurant: { lighting: 'warm studio lighting with soft golden glow', mood: 'appetizing and luxurious', aesthetic: 'Michelin restaurant food photography', colors: 'rich warm golden tones', extra: 'shallow depth of field, steam rising, close-up textures' },
  cafe:       { lighting: 'soft warm morning light', mood: 'cozy and inviting', aesthetic: 'lifestyle coffee photography', colors: 'warm browns, cream, natural tones', extra: 'latte art, steam, rustic textures' },
  beauty:     { lighting: 'soft diffused lighting, clean whites', mood: 'elegant and luxurious', aesthetic: 'luxury beauty brand campaign', colors: 'soft pastels, blush pink, clean white', extra: 'macro detail shots, dewy textures' },
  retail:     { lighting: 'bright clean studio lighting', mood: 'fresh and inviting', aesthetic: 'lifestyle product photography', colors: 'bright and airy, natural tones', extra: 'clean background, styled flat lay' },
  medical:    { lighting: 'clean even lighting, clinical whites', mood: 'trustworthy and calm', aesthetic: 'healthcare brand photography', colors: 'calm blues, clean whites, soft greens', extra: 'trust-building composition' },
  realestate: { lighting: 'golden hour natural lighting', mood: 'aspirational and inviting', aesthetic: 'architectural photography', colors: 'warm golden hour tones, blue sky', extra: 'wide angle, HDR look' },
  education:  { lighting: 'bright warm natural lighting', mood: 'optimistic and engaging', aesthetic: 'education brand photography', colors: 'warm friendly tones, bright accents', extra: 'candid feel, genuine expression' },
  events:     { lighting: 'dramatic colored lighting, stage lights', mood: 'energetic and exciting', aesthetic: 'event photography', colors: 'vibrant saturated colors, light trails', extra: 'motion, energy, bokeh lights' },
  tech:       { lighting: 'clean modern lighting, cool tones', mood: 'innovative and sleek', aesthetic: 'tech brand photography', colors: 'cool blues, dark backgrounds, neon accents', extra: 'minimalist, futuristic feel' },
  automotive: { lighting: 'dramatic automotive lighting, reflections', mood: 'powerful and sleek', aesthetic: 'car advertisement photography', colors: 'deep blacks, metallic highlights', extra: 'motion blur, reflection shots' },
  default:    { lighting: 'professional studio lighting', mood: 'modern and polished', aesthetic: 'commercial brand photography', colors: 'clean natural tones', extra: 'clean composition, professional quality' }
};

const IMAGE_NEGATIVE_PROMPT = 'blurry, low quality, stock photo, watermark, text, logo, oversaturated, dark, muddy, amateur, pixelated, distorted, cartoon, illustration, painting, generic';

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
  const aspect = ['video_thumbnail','reel_cover','instagram_story'].includes(contentType) ? '9:16' : ['blog_featured','facebook_post','ad_creative'].includes(contentType) ? '16:9' : '1:1';
  const audienceCtx = profile?.audience_description ? `, relatable to ${profile.audience_description}` : '';
  const cityCtx = profile?.physical_locations?.[0]?.city ? `, local feel of ${profile.physical_locations[0].city}` : '';

  const structured = `${basePrompt}, ${style.lighting}, composition with clear space for text overlay, ${style.mood} mood, ${style.aesthetic}, ${style.colors}, ${aspect} format, professional marketing photography, commercial quality, ${style.extra}${audienceCtx}${cityCtx}, no text on image, no watermarks`;

  if (plan === 'agency') {
    try {
      const result = await callClaude(
        `You are an expert AI image prompt engineer for a ${profile?.business_type || 'business'}.\nENHANCE this prompt to be vivid and specific. Keep ALL technical details.\nOriginal: "${structured}"\nReturn ONLY the enhanced prompt, max 200 words.`,
        'short_copy', 300, { returnRaw: true });
      const enhanced = typeof result === 'string' ? result : (result?._raw || structured);
      log('buildImagePrompt', `[AGENCY] ${enhanced.slice(0, 120)}...`);
      return enhanced;
    } catch {}
  }

  log('buildImagePrompt', `[${(plan || 'default').toUpperCase()}] ${structured.slice(0, 120)}...`);
  return structured;
}

// ── MAIN: generateSmartImage ─────────────────────────────────────────────────
async function generateSmartImage(businessId, prompt, contentType = 'social_post', plan = 'free') {
  const startTime = Date.now();
  // Fetch profile for business-type-aware image prompts
  let profile = null;
  try { const r = await sbGet('business_profiles', `user_id=eq.${businessId}&select=business_type,physical_locations,audience_description`).catch(() => []); profile = r[0]; } catch {}
  if (!profile) { try { const r = await sbGet('businesses', `id=eq.${businessId}&select=industry,location,target_audience`); if (r[0]) profile = { business_type: r[0].industry, physical_locations: r[0].location ? [{ city: r[0].location }] : [], audience_description: r[0].target_audience }; } catch {} }

  const enhanced  = await buildImagePrompt(prompt, contentType, plan, profile);
  const models    = getModelOrder(plan, contentType);
  const fallbackQ = prompt.split(',')[0] || 'professional business marketing';
  const aspect    = ['video_thumbnail','reel_cover','instagram_story'].includes(contentType) ? '9:16' : ['blog_featured','facebook_post','ad_creative'].includes(contentType) ? '16:9' : '1:1';

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
          return { url: permUrl, source: 'pexels', credit: pex.credit, model_used: 'pexels', generation_time_ms: Date.now() - startTime };
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
async function sendEmail(to, subject, html) {
  const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
  const from   = clean(process.env.FROM_EMAIL)     || FROM_EMAIL;

  if (!apiKey || !to) {
    console.log('[REDACTED]');
    return { queued: true };
  }

  try {
    const r = await apiRequest('POST', 'https://api.resend.com/emails',
      { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
}

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
      const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
      req.on('error', reject); req.write(body); req.end();
    });
    if (resp.sid) { console.log('[REDACTED]'); return { sent: true, sid: resp.sid }; }
    return { error: resp.message || 'unknown' };
  } catch (e) { console.error('[WHATSAPP ERROR]', e.message); return { error: e.message }; }
}

// ─── Webhook dispatcher (fires external webhook subscriptions) ──────────────
async function fireWebhooks(businessId, eventType, data) {
  try {
    const subs = await sbGet('webhook_subscriptions', `business_id=eq.${businessId}&event_type=eq.${eventType}&active=eq.true`);
    for (const sub of subs) {
      apiRequest('POST', sub.webhook_url, { 'Content-Type': 'application/json', 'X-Maroa-Secret': sub.secret || '' },
        { event: eventType, business_id: businessId, timestamp: new Date().toISOString(), data }).catch(() => {});
    }
  } catch {}
}

// ─── Simple rate limiter ─────────────────────────────────────────────────────
const rateLimitStore = new Map();
function rateLimit(key, maxPerWindow, windowMs = 60000) {
  const now = Date.now();
  const bucket = rateLimitStore.get(key) || [];
  const valid = bucket.filter(ts => ts > now - windowMs);
  if (valid.length >= maxPerWindow) return false; // over limit
  valid.push(now);
  rateLimitStore.set(key, valid);
  return true; // allowed
}
// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitStore) {
    const valid = v.filter(ts => ts > now - 300000);
    if (valid.length === 0) rateLimitStore.delete(k);
    else rateLimitStore.set(k, valid);
  }
}, 300000);

// ─── Simple response cache (30s TTL) ────────────────────────────────────────
const responseCache = new Map();
function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < 30000) return entry.data;
  responseCache.delete(key);
  return null;
}
function setCache(key, data) { responseCache.set(key, { data, ts: Date.now() }); }

// ═════════════════════════════════════════════════════════════════════════════
// PREMIUM INTELLIGENCE ENGINE — Multi-pass, Memory, Scheduling, Recovery
// ═════════════════════════════════════════════════════════════════════════════

// ── T1.1: Multi-pass content generation (generate → critique → refine) ──────
async function generateWithRefinement(basePrompt, taskType, profile, bizId) {
  // Pass 1: Generate with Opus
  const draft = await callClaude(basePrompt, taskType || 'social_post', 3000);
  if (draft._raw || !draft) return draft; // unparseable — return as-is

  const mainText = draft.instagram_caption || draft.facebook_post || draft.email_body || JSON.stringify(draft).slice(0, 500);
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
  } catch (e) { log('multiPass', `Critique skipped: ${e.message}`); }
  return draft;
}

// ── T1.3: Platform rules enforcement ─────────────────────────────────────────
const PLATFORM_RULES = {
  instagram: { maxLen: 2200, hashtagCount: 5, hookLen: 125 },
  facebook: { maxLen: 500, hashtagCount: 2, hookLen: 80 },
  email: { subjectMax: 60, bodyMax: 800 },
  whatsapp: { maxLen: 160 },
  ad: { headlineMax: 40, bodyMax: 125 }
};

function enforcePlatformRules(text, platform, profile) {
  if (!text || typeof text !== 'string') return text;
  const rules = PLATFORM_RULES[platform];
  if (!rules) return text;
  // Truncate if too long
  if (rules.maxLen && text.length > rules.maxLen) text = text.slice(0, rules.maxLen - 3) + '...';
  // Add local hashtags for social platforms if missing
  if ((platform === 'instagram' || platform === 'facebook') && !text.includes('#') && profile?.physical_locations?.[0]?.city) {
    const city = profile.physical_locations[0].city.toLowerCase().replace(/\s+/g, '');
    text += `\n\n#${city} #kosova`;
  }
  return text;
}

// ── T2.1: Memory system (AI learns from every interaction) ───────────────────
async function storeMemory(userId, memoryType, action, contentSnippet, platform, pattern) {
  try {
    await sbPost('ai_memory', {
      user_id: userId, memory_type: memoryType, action,
      content_snippet: (contentSnippet || '').slice(0, 500),
      platform: platform || 'general',
      learned_pattern: (pattern || '').slice(0, 500)
    }).catch(() => {});
  } catch {}
}

async function getMemoryContext(userId) {
  try {
    const rows = await sbGet('ai_memory', `user_id=eq.${userId}&order=created_at.desc&limit=30`);
    if (!rows.length) return '';
    const wins = rows.filter(r => r.memory_type === 'content_wins' || r.action === 'approved' || r.action === 'high_performance');
    const losses = rows.filter(r => r.memory_type === 'content_losses' || r.action === 'rejected' || r.action === 'low_performance');
    const prefs = rows.filter(r => r.memory_type === 'preferences' || r.action === 'edited');
    let ctx = '\n═══ AI MEMORY — WHAT I KNOW ABOUT THIS BUSINESS ═══\n';
    if (wins.length) ctx += `What worked (${wins.length} wins):\n${wins.slice(0, 5).map(w => `- ${w.learned_pattern || w.content_snippet?.slice(0, 80) || w.action}`).join('\n')}\n`;
    if (losses.length) ctx += `What didn't work (${losses.length}):\n${losses.slice(0, 3).map(l => `- ${l.learned_pattern || l.action}`).join('\n')}\n`;
    if (prefs.length) ctx += `Client preferences:\n${prefs.slice(0, 3).map(p => `- ${p.action}: ${p.content_snippet?.slice(0, 60) || ''}`).join('\n')}\n`;
    ctx += 'Apply all learnings to make content better than before.\n';
    return ctx;
  } catch { return ''; }
}

const promptCache = new Map();
const PROMPT_CACHE_TTL = 5 * 60 * 1000;

async function getCachedMasterPrompt(cacheSubjectId, profile, taskType, extraCtx) {
  const { buildMasterPromptWithSkills } = require('./services/masterPromptBuilder');
  const keyExtra = crypto.createHash('sha256').update(String(extraCtx || '')).digest('hex').slice(0, 24);
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
    const recent = await sbGet('generated_content', `business_id=eq.${userId}&status=eq.published&order=created_at.desc&limit=1&select=created_at`).catch(() => []);
    if (!recent.length || (Date.now() - new Date(recent[0]?.created_at).getTime()) > 3 * 86400000) {
      ops.push({ type: 'posting_gap', priority: 'urgent', title: 'No post in 3+ days', action: 'Generate and publish content today' });
    }
    // Check holiday
    try {
      const { getKosovoAlbaniaHolidays } = require('./services/masterPromptBuilder');
      const holidays = getKosovoAlbaniaHolidays(new Date());
      if (holidays.length) ops.push({ type: 'holiday', priority: 'high', title: holidays[0], action: 'Create holiday-themed content' });
    } catch {}
    // Check competitor activity
    const intel = await sbGet('business_intelligence', `user_id=eq.${userId}&source_module=eq.competitors&order=updated_at.desc&limit=1`).catch(() => []);
    if (intel.length && (Date.now() - new Date(intel[0].updated_at).getTime()) < 86400000) {
      ops.push({ type: 'competitor', priority: 'high', title: 'Competitor activity detected', action: intel[0].insight_value?.slice(0, 100) || 'Create counter-content' });
    }
  } catch {}
  return ops.sort((a, b) => ({ urgent: 0, high: 1, medium: 2 }[a.priority] || 3) - ({ urgent: 0, high: 1, medium: 2 }[b.priority] || 3));
}

// ── T3.2: Smart scheduling (optimal posting times for Kosovo/Albania) ────────
function getOptimalPostingTime(platform, businessType) {
  const type = (businessType || '').toLowerCase();
  const now = new Date();
  const hours = {
    instagram: type.includes('fitness') ? [7, 12, 17, 20] : type.includes('restaurant') ? [11, 12, 17, 19] : [8, 12, 19, 20],
    facebook: type.includes('restaurant') ? [11, 17, 18] : [9, 13, 19],
    email: [9, 10, 11]
  };
  const bestHours = hours[platform] || hours.instagram;
  // Find next available hour
  for (let dayOff = 0; dayOff <= 2; dayOff++) {
    const d = new Date(now); d.setDate(d.getDate() + dayOff);
    if (d.getDay() === 0) continue; // Skip Sunday
    for (const h of bestHours) {
      if (dayOff === 0 && h <= now.getHours()) continue;
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    }
  }
  const tmrw = new Date(now); tmrw.setDate(tmrw.getDate() + 1); tmrw.setHours(9, 0, 0, 0);
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
    try { client.write(`data: ${JSON.stringify({ type: eventType, timestamp: new Date().toISOString(), ...data })}\n\n`); } catch {}
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
    { m:1,  d:1,  name:"New Year's Day" },    { m:1,  d:15, name:"MLK Day" },
    { m:2,  d:14, name:"Valentine's Day" },   { m:3,  d:17, name:"St. Patrick's Day" },
    { m:5,  d:5,  name:"Cinco de Mayo" },      { m:5,  d:12, name:"Mother's Day" },
    { m:5,  d:27, name:"Memorial Day" },       { m:6,  d:19, name:"Juneteenth" },
    { m:7,  d:4,  name:"Independence Day" },  { m:9,  d:2,  name:"Labor Day" },
    { m:10, d:31, name:"Halloween" },          { m:11, d:11, name:"Veterans Day" },
    { m:11, d:28, name:"Thanksgiving" },       { m:12, d:24, name:"Christmas Eve" },
    { m:12, d:25, name:"Christmas" },          { m:12, d:31, name:"New Year's Eve" }
  ];
  const now  = new Date();
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
  const ig   = c.instagram_caption  || '';
  const ig2  = c.instagram_caption_2 || '';
  const fb   = c.facebook_post      || '';
  const sub  = c.email_subject      || '';
  const hl   = c.google_ad_headline || '';
  const desc = c.google_ad_description || '';

  if ((ig.match(/[\u{1F000}-\u{1FFFF}]/gu) || []).length >= 3) score += 10; // 3+ emojis
  if ((ig.match(/#\w+/g) || []).length >= 5) score += 15;  // 5+ hashtags
  if (ig.includes('?')) score += 5;                          // question
  if (ig2.length > 80) score += 10;
  if (fb.split(' ').length >= 100) score += 15;              // 100+ words Facebook
  if (sub.length > 5 && sub.length <= 50) score += 10;       // good email subject
  if (hl.length > 0 && hl.length <= 30) score += 10;         // headline char limit
  if (desc.length > 0 && desc.length <= 90) score += 10;     // desc char limit
  if (c.content_theme) score += 5;
  if (c.image_prompt) score += 5;
  if (c.linkedin_post && c.linkedin_post.length > 100) score += 5;

  return Math.min(score, 100);
}

// ─── Self-learning system ─────────────────────────────────────────────────────
async function updateLearning(businessId) {
  try {
    const perf = await sbGet('content_performance',
      `business_id=eq.${businessId}&select=content_id,content_theme,reach,likes,shares,comments`);
    if (!perf.length) return;

    // Group by theme and score
    const themes = {};
    for (const p of perf) {
      const t = p.content_theme || 'unknown';
      if (!themes[t]) themes[t] = { reach: 0, engage: 0, count: 0 };
      themes[t].reach   += (p.reach   || 0);
      themes[t].engage  += (p.likes || 0) + (p.shares || 0) * 3 + (p.comments || 0) * 2;
      themes[t].count   += 1;
    }

    const scored = Object.entries(themes)
      .map(([theme, d]) => ({ theme, avg: (d.reach / d.count) + (d.engage / d.count) * 2 }))
      .sort((a, b) => b.avg - a.avg);

    const best  = scored.slice(0, 3).map(s => s.theme);
    const worst = scored.slice(-3).map(s => s.theme);

    await sbPatch('businesses', `id=eq.${businessId}`, {
      best_performing_themes  : JSON.stringify(best),
      worst_performing_themes : JSON.stringify(worst)
    });

    const lesson = `Best themes: ${best.join(', ')}. Avoid: ${worst.join(', ')}. Based on ${perf.length} data points.`;
    await sbPost('learning_logs', {
      business_id     : businessId,
      lesson_type     : 'theme_performance',
      lesson_content  : lesson,
      confidence_score: Math.min(perf.length / 20, 1),
      applied_at      : new Date().toISOString()
    });

    logger.info('updateLearning', businessId, 'themes updated', { best, worst });
  } catch (e) {
    logger.error('updateLearning', businessId, 'learning error', e);
  }
}

// ─── Log helper ───────────────────────────────────────────────────────────────
function log(route, msg) { console.log(`[${new Date().toISOString()}] ${route} — ${msg}`); }
function requireAdminSecret(req, res, next) {
  if (!ORCHESTRATOR_SECRET) return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'Admin secret not configured');
  const provided = clean(
    req.headers['x-orchestrator-secret'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  );
  if (provided !== ORCHESTRATOR_SECRET) return apiError(res, 401, 'UNAUTHORIZED', 'Invalid secret');
  next();
}

function safePublicError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('supabase') || msg.includes('sbget') || msg.includes('sbpost') || msg.includes('sbpatch')) return 'Data service error';
  if (msg.includes('claude') || msg.includes('anthropic') || msg.includes('openai')) return 'AI service temporarily unavailable';
  if (msg.includes('database') || msg.includes('sql')) return 'Service temporarily unavailable';
  return 'Service temporarily unavailable';
}

function requireValidUserId(req, res, next) {
  const { userId } = req.body || {};
  if (!userId || typeof userId !== 'string' || userId.length < 10) {
    return apiError(res, 400, 'VALIDATION_ERROR', 'Valid userId required');
  }
  if (!isUUID(userId)) {
    return apiError(res, 400, 'VALIDATION_ERROR', 'userId must be a valid UUID');
  }
  next();
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
    await sbPost('errors', { business_id: businessId, workflow_name: workflowName,
      error_message: errorMessage, retry_payload: retryPayload ? JSON.stringify(retryPayload) : null });
    if (businessId) setImmediate(() => alertOnRepeatedFailure(businessId, workflowName).catch(() => {}));
  } catch {}
}

// ─── UUID validation helper ──────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /health — detailed environment check ───────────────────────────────
app.get('/health', (req, res) => {
  logger.info('/health', null, 'health check', { request_id: req.requestId });
  const vars = {
    anthropic:  !!ANTHROPIC_KEY || !!process.env.ANTHROPIC_API_KEY,
    supabase:   !!SUPABASE_KEY,
    meta:       !!(process.env.META_APP_ID || process.env.META_APP_SECRET),
    resend:     !!RESEND_API_KEY,
    serpapi:    !!SERPAPI_KEY,
    pinecone:   !!(PINECONE_API_KEY && PINECONE_HOST) || !!(process.env.PINECONE_API_KEY && process.env.PINECONE_HOST),
    replicate:  !!REPLICATE_API_KEY,
    openai:     !!OPENAI_API_KEY || !!process.env.OPENAI_API_KEY,
    linkedin:   !!process.env.LINKEDIN_CLIENT_ID,
    tiktok:     !!process.env.TIKTOK_CLIENT_KEY || !!process.env.TIKTOK_CLIENT_SECRET,
    twitter:    !!process.env.TWITTER_CLIENT_ID || !!process.env.TWITTER_CLIENT_SECRET,
    paddle:     !!process.env.PADDLE_API_KEY,
    runway:     !!RUNWAY_API_KEY || !!process.env.RUNWAY_API_KEY,
    google_ai:  !!GOOGLE_AI_API_KEY,
    twilio:     !!TWILIO_ACCOUNT_SID,
    paddle_billing: !!paddle.PADDLE_API_KEY
  };
  const missing = Object.entries(vars).filter(([,v]) => !v).map(([k]) => k);
  // Diagnostic: show raw env var presence for the missing ones
  const raw_check = {
    OPENAI_API_KEY:     process.env.OPENAI_API_KEY    ? 'SET' : 'NOT SET',
    PINECONE_API_KEY:   process.env.PINECONE_API_KEY  ? 'SET' : 'NOT SET',
    PINECONE_HOST:      process.env.PINECONE_HOST     ? 'SET' : 'NOT SET',
    PADDLE_API_KEY:     process.env.PADDLE_API_KEY ? 'SET' : 'NOT SET',
    RUNWAY_API_KEY:     process.env.RUNWAY_API_KEY    ? 'SET' : 'NOT SET',
    TIKTOK_CLIENT_KEY:  process.env.TIKTOK_CLIENT_KEY ? 'set' : 'NOT SET',
    TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET ? 'set' : 'NOT SET',
    TWITTER_CLIENT_ID:  process.env.TWITTER_CLIENT_ID ? 'set' : 'NOT SET',
    GOOGLE_AI_API_KEY:  process.env.GOOGLE_AI_API_KEY ? 'SET' : 'NOT SET'
  };
  res.json({ status: missing.length <= 3 ? 'ok' : 'degraded', timestamp: new Date().toISOString(), env_vars: vars, missing_vars: missing, missing_count: missing.length, raw_check });
});

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok', service: 'maroa-api', version: '2.2.0',
  env: {
    SUPABASE_KEY  : SUPABASE_KEY  ? 'SET'  : 'MISSING',
    ANTHROPIC_KEY : ANTHROPIC_KEY ? 'SET'  : 'MISSING',
    SERPAPI_KEY   : SERPAPI_KEY   ? 'set' : 'MISSING',
    REPLICATE     : REPLICATE_API_KEY ? 'set' : 'MISSING',
    RESEND        : (clean(process.env.RESEND_API_KEY)||RESEND_API_KEY) ? 'set' : 'MISSING — emails queued'
  },
  routes: [
    // ── Core webhooks ──────────────────────────────────────────────────
    'POST /webhook/new-user-signup',
    'POST /webhook/instant-content',
    'POST /webhook/account-connected',
    'POST /webhook/create-campaigns',
    'POST /webhook/content-approved',
    'POST /webhook/budget-updated',
    'POST /webhook/competitor-check',
    'POST /webhook/generate-landing-page',
    // ── Billing ────────────────────────────────────────────────────────
    'GET  /api/billing/plans',
    'POST /webhook/create-checkout',
    // ── Agency / Multi-workspace ───────────────────────────────────────
    'POST /webhook/org-create',
    'GET  /webhook/org-get',
    'POST /webhook/org-add-workspace',
    'POST /webhook/org-invite-member',
    'POST /webhook/org-white-label-update',
    // ── LinkedIn ───────────────────────────────────────────────────────
    'POST /webhook/linkedin-oauth-exchange',
    'POST /webhook/linkedin-publish',
    // ── Twitter / X ───────────────────────────────────────────────────
    'POST /webhook/twitter-oauth-exchange',
    'POST /webhook/twitter-publish',
    // ── TikTok ────────────────────────────────────────────────────────
    'POST /webhook/tiktok-oauth-exchange',
    'POST /webhook/tiktok-publish',
    // ── Analytics (Sprint 2.1) ─────────────────────────────────────────
    'POST /webhook/analytics-snapshot',
    'POST /webhook/analytics-report',
    'GET  /webhook/analytics-get',
    // ── Email Sequences (Sprint 2.2) ───────────────────────────────────
    'POST /webhook/email-sequence-create',
    'POST /webhook/email-enroll',
    'POST /webhook/email-trigger',
    'POST /webhook/email-sequence-process',
    'GET  /webhook/no-open-candidates',
    // ── Meta OAuth ────────────────────────────────────────────────────
    'POST /meta-oauth-exchange',
    // ── Utilities ─────────────────────────────────────────────────────
    'POST /test-email',
    'GET  /debug'
  ]
}));

// Debug
app.get('/debug', requireAdminSecret, async (req, res) => {
  const out = {};
  try { const r = await sbGet('businesses', 'select=id&limit=1'); out.supabase = `ok (${r.length} row)`; }
  catch (e) { out.supabase = `ERROR: ${e.message}`; }
  try {
    const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages',
      { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] });
    out.anthropic = r.status === 200 ? 'ok' : `ERROR ${r.status}`;
  } catch (e) { out.anthropic = `ERROR: ${e.message}`; }
  try {
    const r = await serpSearch('test', 1);
    out.serpapi = r.length ? 'ok' : 'no results (key may be invalid)';
  } catch (e) { out.serpapi = `ERROR: ${e.message}`; }

  // Meta / OAuth env vars
  const metaSecret = clean(process.env.META_APP_SECRET) || '';
  const metaAppId  = clean(process.env.META_APP_ID)     || '';
  out.META_APP_SECRET = metaSecret ? 'SET' : 'MISSING ❌ — set this in Railway env vars';
  out.META_APP_ID     = metaAppId  ? 'SET' : 'MISSING';
  out.RESEND_API_KEY  = (clean(process.env.RESEND_API_KEY) || '') ? 'set' : 'missing';
  out.REPLICATE_API_KEY = (clean(process.env.REPLICATE_API_KEY) || '') ? 'set' : 'missing';

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
      user_id, email, business_name, industry, website, first_name,
      target_audience, main_goal, platforms, monthly_budget,
      posting_frequency, plan = 'free'
    } = req.body;

    log('/webhook/new-user-signup', `user_id=${user_id} email=${email} business=${business_name}`);

    if (!email && !user_id) {
      log('/webhook/new-user-signup', 'Missing email and user_id — skipping');
      return;
    }

    // ── Check if business already exists for this user ──────────────────────
    let bizId = null;

    // Try by user_id first
    if (user_id) {
      const existing = await sbGet('businesses', `user_id=eq.${user_id}&select=id`);
      if (existing[0]) {
        bizId = existing[0].id;
        log('/webhook/new-user-signup', `Found existing business by user_id: ${bizId}`);
      }
    }

    // Try by email if not found by user_id
    if (!bizId && email) {
      const existing = await sbGet('businesses', `email=eq.${encodeURIComponent(email)}&select=id`);
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
    Object.keys(bizData).forEach(k => bizData[k] === undefined && delete bizData[k]);

    if (bizId) {
      // ── Update existing business ───────────────────────────────────────────
      await sbPatch('businesses', `id=eq.${bizId}`, bizData);
      log('/webhook/new-user-signup', `Updated existing business: ${bizId}`);
    } else {
      // ── Create new business ────────────────────────────────────────────────
      const insertData = {
        ...bizData,
        user_id: user_id,
        email: email,
        first_name: first_name,
        plan: plan,
        is_active: true,
        created_at: new Date().toISOString(),
      };
      Object.keys(insertData).forEach(k => insertData[k] === undefined && delete insertData[k]);

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
          'research', 1000
        );
        if (brandVoice && !brandVoice._raw) {
          await sbPatch('businesses', `id=eq.${bizId}`, { brand_voice_locked: JSON.stringify(brandVoice) });
          log('/webhook/new-user-signup', `Brand voice extracted for ${bizId}`);
        }
      } catch (e) { log('/webhook/new-user-signup', `Brand voice WARN: ${e.message}`); }
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
  <a href="https://maroa-frontend.vercel.app/dashboard" style="background:#0A84FF;color:white;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:bold;font-size:16px">Open Dashboard</a>
</div>
</body></html>`;
        await sendEmail(email, `Welcome ${firstName}! Your AI marketing is live`, html);
        log('/webhook/new-user-signup', `Welcome email sent to ${email}`);
      } catch (e) { log('/webhook/new-user-signup', `Email WARN: ${e.message}`); }
    }

    log('/webhook/new-user-signup', `✅ Complete for ${business_name} (${bizId})`);

  } catch (err) {
       logger.error('/webhook/new-user-signup', null, 'handler error', err, { request_id: req.requestId });
    try { await logError(null, 'new-user-signup', err.message, req.body); } catch (_) {}
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
    sbGet('business_profiles', `user_id=eq.${bizId}&select=*`).catch(() => [])
  ]);

  const biz   = bizArr[0];
  if (!biz) throw new Error(`Business ${bizId} not found`);

  const perfThemesBlock = await fetchPerformanceThemesContextBlock(bizId);

  // If rich profile exists, build master prompt for enhanced accuracy
  const profile = profileArr[0] || null;
  let masterSystemPrompt = '';
  if (profile && profile.physical_locations && Array.isArray(profile.physical_locations) && profile.physical_locations.length > 0) {
    try {
      const extraCtx = perfThemesBlock ? `${perfThemesBlock}` : '';
      const cacheSubject = profile.user_id || bizId;
      masterSystemPrompt = await getCachedMasterPrompt(cacheSubject, profile, 'social_post', extraCtx);
      log('generateContent', `Using master prompt + marketing skills for ${biz.business_name} (profile score: ${profile.profile_score})`);
    } catch (e) {
      // Fallback to basic master prompt without skills
      try {
        const { buildMasterPrompt: bmp } = require('./services/masterPromptBuilder');
        masterSystemPrompt = bmp(profile, 'social_post') + (perfThemesBlock ? `\n\n${perfThemesBlock}\n\n` : '\n\n');
      } catch {}
      log('generateContent', `Master prompt fallback (skills unavailable): ${e.message}`);
    }
  } else if (perfThemesBlock) {
    masterSystemPrompt = `${perfThemesBlock}\n\n`;
  }

  const comp    = compInsights[0];
  const lesson  = learningArr[0];
  const nowDate = new Date();
  const month   = nowDate.toLocaleString('default', { month: 'long' });

  const platforms = (() => {
    try { return JSON.parse(biz.selected_platforms || '[]').join(', ') || 'Instagram, Facebook'; }
    catch { return 'Instagram, Facebook'; }
  })();

  const bestThemes  = (() => { try { return JSON.parse(biz.best_performing_themes  || '[]').join(', ') || 'None yet'; } catch { return 'None yet'; } })();
  const worstThemes = (() => { try { return JSON.parse(biz.worst_performing_themes || '[]').join(', ') || 'None yet'; } catch { return 'None yet'; } })();
  const aiBrain     = (() => { try { return JSON.stringify(JSON.parse(biz.ai_brain_decisions || '{}')); } catch { return 'No decisions yet'; } })();
  const brandVoice  = biz.brand_voice_locked || biz.brand_tone || 'professional, warm, helpful';

  const recentThemes = recentContent.map(c => c.content_theme).filter(Boolean).join(', ') || 'None yet';

  // ── UPGRADE 3: Fetch brand memory examples + latest competitor report ──
  const brandContext = await getBrandExamples(bizId, 'social_post', `${biz.business_name} ${biz.industry || ''} marketing`);
  let competitorReport = '';
  try {
    const compReports = await sbGet('competitor_reports', `business_id=eq.${bizId}&order=created_at.desc&limit=1`);
    if (compReports[0]?.recommendation) {
      competitorReport = `LATEST COMPETITOR REPORT RECOMMENDATION:\n${compReports[0].recommendation}\n\n`;
    }
  } catch {}

  const prompt =
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
  let score   = scoreContent(content);

  // ── UPGRADE 3: Generate 3 variations, pick the highest scoring one ────
  const variations = [{ content, score }];
  if (score < 90 && !content._raw) {
    // Generate 2 more variations in parallel
    const [v2, v3] = await Promise.all([
      callClaude(prompt + `\n\nVARIATION 2: Use a completely different angle, hook, and content theme. Be creative and bold.`, 'social_post', 3000, bizClaude).catch(() => null),
      callClaude(prompt + `\n\nVARIATION 3: Focus on storytelling and emotion. Make the audience FEEL something.`, 'social_post', 3000, bizClaude).catch(() => null)
    ]);
    if (v2 && !v2._raw) variations.push({ content: v2, score: scoreContent(v2) });
    if (v3 && !v3._raw) variations.push({ content: v3, score: scoreContent(v3) });
    // Pick the winner
    variations.sort((a, b) => b.score - a.score);
    content = variations[0].content;
    score   = variations[0].score;
    log('generateContent', `3-variation contest: scores=[${variations.map(v=>v.score).join(',')}] winner=${score}`);
  }

  // Generate image via smart model router (plan-aware)
  const imgPrompt = content.image_prompt || `Professional marketing photo for ${biz.business_name}, ${biz.industry || 'business'}`;
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
    never_do: profile?.never_do
  };
  let gateStatus = 'approved';
  try {
    const { validateContent } = require('./services/contentValidator');
    const mainText = content.instagram_caption || content.facebook_post || '';
    let validation = validateContent(mainText, profileForVal, 'social_post');
    if (!validation.valid && validation.issues.length > 0) {
      log('contentValidator', `Issues found: ${validation.issues.join(', ')} — repair pass...`);
      const fixPrompt = prompt + `\n\nPREVIOUS ATTEMPT HAD THESE ISSUES — FIX THEM:\n${validation.issues.join('\n')}\nGenerate corrected JSON only.`;
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
  } catch (valErr) { log('contentValidator', `Validation skipped: ${valErr.message}`); }

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
          system: 'You are a marketing strategist. Be specific and brief. Output one sentence only, plain text, no JSON.',
          businessId: bizId
        }
      );
      strategy_reason = typeof reasonRaw === 'string' ? reasonRaw.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
    }
  } catch (e) { log('strategy_reason', e.message); }

  // ── LEVEL 6: Automated A/B testing — save both winner (A) and runner-up (B) ─
  let abTestId = null;
  const runnerUp = variations.length > 1 ? variations[1] : null;
  if (runnerUp) {
    try {
      const testRow = await sbPost('ab_tests', {
        business_id: bizId,
        variant_a: JSON.stringify({ theme: content.content_theme, caption: (content.instagram_caption || '').slice(0, 500) }),
        variant_b: JSON.stringify({ theme: runnerUp.content.content_theme, caption: (runnerUp.content.instagram_caption || '').slice(0, 500) }),
        started_at: new Date().toISOString()
      });
      abTestId = testRow?.id || null;
    } catch {}
  }

  // Save to generated_content (Variant A — winner)
  const saved = await sbPost('generated_content', {
    business_id           : bizId,
    instagram_caption     : content.instagram_caption     || '',
    instagram_caption_2   : content.instagram_caption_2   || '',
    facebook_post         : content.facebook_post         || '',
    instagram_story_text  : content.instagram_story_text  || '',
    email_subject         : content.email_subject         || '',
    email_body            : content.email_body            || '',
    blog_title            : content.blog_title            || '',
    google_ad_headline    : content.google_ad_headline    || '',
    google_ad_description : content.google_ad_description || '',
    content_theme         : content.content_theme         || '',
    image_url             : imgResult.url || '',
    image_source          : imgResult.source || '',
    image_credit          : imgResult.credit || '',
    strategy_reason       : strategy_reason || null,
    status                : gateStatus === 'needs_review' ? 'needs_review' : 'approved',
    variant               : 'A',
    ab_test_id            : abTestId,
    pre_post_score        : score
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
        scheduled_for: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString() // evening
      });
    } catch {}
  }

  log('generateContent', `✅ saved row ${saved?.id} score=${score} theme="${content.content_theme}" img=${imgResult.source}`);

  // Update learning data after every generation
  setImmediate(() => updateLearning(bizId));

  // ── Performance feedback loop: check engagement after 24 hours ────────
  if (saved?.id && biz.meta_access_token && biz.facebook_page_id) {
    const contentId = saved.id;
    const token     = biz.meta_access_token;
    const pageId    = biz.facebook_page_id;
    setTimeout(async () => {
      try {
        log('feedback-loop', `Checking 24h performance for content ${contentId}`);
        // Fetch page post insights from Meta Graph API
        const postsResp = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/${pageId}/posts?fields=id,message,insights.metric(post_impressions,post_engaged_users)&limit=5&access_token=${token}`, {});
        const posts = postsResp.body?.data || [];
        // Find the most recent post (likely the one we published)
        let totalImpressions = 0, totalEngagement = 0;
        for (const p of posts) {
          const metrics = p.insights?.data || [];
          for (const m of metrics) {
            if (m.name === 'post_impressions') totalImpressions += (m.values?.[0]?.value || 0);
            if (m.name === 'post_engaged_users') totalEngagement += (m.values?.[0]?.value || 0);
          }
        }
        const performanceScore = totalImpressions > 0
          ? Math.min(10, Math.round((totalEngagement / totalImpressions) * 100))
          : 0;
        // Update content with performance score + reach
        await sbPatch('generated_content', `id=eq.${contentId}`, {
          performance_score: performanceScore,
          total_reach: totalImpressions
        });
        log('feedback-loop', `Content ${contentId}: score=${performanceScore} reach=${totalImpressions} engagement=${totalEngagement}`);
        // If high performing, store in brand memory
        if (performanceScore >= 7) {
          try {
            const bestText = content.instagram_caption || content.facebook_post || '';
            if (bestText && OPENAI_API_KEY && PINECONE_API_KEY && PINECONE_HOST) {
              const vector = await getEmbedding(bestText);
              await pineconeUpsert([{
                id: contentId,
                values: vector,
                metadata: { businessId: bizId, contentType: 'social_post', text: bestText.slice(0, 1000), score: performanceScore }
              }]);
              log('feedback-loop', `✅ High-performing content stored in brand memory: ${contentId}`);
            }
          } catch (memErr) { log('feedback-loop', `Brand memory store failed: ${memErr.message}`); }
        }
      } catch (err) { log('feedback-loop', `24h check error: ${err.message}`); }
    }, 24 * 60 * 60 * 1000); // 24 hours
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
<p><a href="https://maroa-ai-marketing-automator.vercel.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve Content</a></p>`;
        await sendEmail(email, `Your ${result.content_theme || 'weekly'} content is ready!`, html);
      }
      try { storeInsight(business_id, 'content', 'content_performance', 'top_content_type', `${result.content_theme || 'general'}: ${(result.instagram_caption || '').slice(0, 80)}`); } catch {}
      logger.info('/webhook/instant-content', business_id, 'generation complete', { theme: result.content_theme, request_id: req.requestId });
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
  const { business_id, meta_access_token, linkedin_access_token, tiktok_access_token, google_access_token } = req.body;
  logger.info('/webhook/account-connected', business_id || null, 'request received', { request_id: req.requestId });

  if (!business_id) return apiError(res, 400, 'VALIDATION_ERROR', 'business_id required');
  res.json({ received: true, message: 'Account connections being processed' });

  try {
    const updates   = { social_accounts_connected: true };
    const connected = [];

    // ── Facebook + Instagram ──────────────────────────────────────────────────
    if (meta_access_token) {
      try {
        // Step A: check if this is a user token or page token
        const debugResp = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/debug_token?input_token=${meta_access_token}&access_token=${meta_access_token}`);
        const tokenType   = debugResp.body?.data?.type;        // "USER" or "PAGE"
        const granular    = debugResp.body?.data?.granular_scopes || [];
        log('/webhook/account-connected', `Token type: ${tokenType}`);

        // Step B: if user token, exchange for page token via /me/accounts
        let pageToken = meta_access_token;
        let pageId    = req.body.facebook_page_id || null;
        let pageName  = '';
        let fanCount  = 0;

        if (tokenType === 'USER' || !tokenType) {
          const pagesResp = await apiRequest('GET',
            `https://graph.facebook.com/v19.0/me/accounts?access_token=${meta_access_token}&fields=id,name,access_token,fan_count`);
          const pages = pagesResp.body?.data || [];
          // If a specific page ID was passed, match it; otherwise take the first page
          const page = pageId
            ? pages.find(p => p.id === pageId) || pages[0]
            : pages[0];

          if (page) {
            pageToken = page.access_token;   // real page token — never expires
            pageId    = page.id;
            pageName  = page.name;
            fanCount  = page.fan_count || 0;
            log('/webhook/account-connected', `Exchanged to page token for: ${page.name} (${page.id})`);
          }
        } else if (tokenType === 'PAGE') {
          // Already a page token — extract page ID from debug data
          pageId   = debugResp.body?.data?.profile_id || pageId;
          pageName = 'Maroa.ai';
        }

        // Save page token (not user token)
        updates.meta_access_token = pageToken;
        if (pageId)   updates.facebook_page_id = pageId;
        if (fanCount) updates.followers_gained  = fanCount;
        if (pageName) connected.push(`Facebook (${pageName})`);
        else if (pageId) connected.push(`Facebook`);

        // Step C: get Instagram ID
        // Try 1: page fields
        let igId = null;
        if (pageId) {
          const igPageResp = await apiRequest('GET',
            `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account,connected_instagram_account&access_token=${pageToken}`);
          igId = igPageResp.body?.instagram_business_account?.id
              || igPageResp.body?.connected_instagram_account?.id
              || null;
        }

        // Try 2: extract from token's granular_scopes (instagram_basic target_ids)
        if (!igId) {
          const igScope = granular.find(s => s.scope === 'instagram_basic');
          igId = igScope?.target_ids?.[0] || null;
          if (igId) log('/webhook/account-connected', `Got IG ID from granular_scopes: ${igId}`);
        }

        if (igId) {
          updates.instagram_account_id = igId;
          connected.push('Instagram');
        }

      } catch (e) { log('/webhook/account-connected', `FB warn: ${e.message}`); }
    }

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    if (linkedin_access_token) {
      updates.linkedin_access_token = linkedin_access_token;
      try {
        const liResp = await apiRequest('GET', 'https://api.linkedin.com/v2/me',
          { 'Authorization': `Bearer ${linkedin_access_token}` });
        if (liResp.status === 200) {
          updates.linkedin_page_id = liResp.body?.id || '';
          connected.push('LinkedIn');
        }
      } catch (e) { log('/webhook/account-connected', `LinkedIn warn: ${e.message}`); }
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
    await sbPost('onboarding_events', { business_id, event_type: 'account_connected',
      event_data: JSON.stringify({ connected, timestamp: new Date().toISOString() }) });

    log('/webhook/account-connected', `✅ Connected: ${connected.join(', ')}`);

    // Trigger campaign creation if budget set
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=daily_budget,meta_access_token,email`))[0];
    if ((biz?.daily_budget || 0) > 0 && (updates.meta_access_token || biz?.meta_access_token)) {
      setImmediate(async () => {
        try {
          const r = await apiRequest('POST', `http://localhost:${PORT}/webhook/create-campaigns`,
            { 'Content-Type': 'application/json' }, { business_id });
          log('/webhook/account-connected', `Campaigns triggered: ${r.status}`);
        } catch {}
      });
    }

    // Send connected email
    if (biz?.email) {
      const html = `<h2>Platforms Connected!</h2><p>You've successfully connected: <strong>${connected.join(', ')}</strong></p>
<p>Your AI will now post automatically and track performance across all platforms.</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Dashboard</a></p>`;
      await sendEmail(biz.email, `${connected.length} platform${connected.length > 1 ? 's' : ''} connected to maroa.ai!`, html);
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
    const campaignList = Array.isArray(campaigns) ? campaigns : (campaigns?.campaigns || [campaigns]);

    const objectives = ['REACH', 'POST_ENGAGEMENT', 'LINK_CLICKS'];
    const savedIds   = [];

    for (let i = 0; i < Math.min(campaignList.length, 3); i++) {
      const c = campaignList[i];
      const saved = await sbPost('ad_campaigns', {
        business_id,
        business_name      : biz.business_name,
        status             : 'pending',
        daily_budget       : c.daily_budget || Math.floor((biz.daily_budget || 10) * [0.4, 0.25, 0.35][i]),
        last_decision      : 'Created by AI',
        last_decision_reason: c.campaign_name || `Campaign ${i + 1}`
      });
      savedIds.push(saved?.id);

      // Create on Meta Marketing API if token available
      if (biz.meta_access_token && biz.ad_account_id) {
        try {
          const metaResp = await apiRequest('POST',
            `https://graph.facebook.com/v19.0/act_${biz.ad_account_id}/campaigns`,
            { 'Content-Type': 'application/json' },
            {
              name                : c.campaign_name || `Maroa ${['Awareness','Engagement','Retargeting'][i]}`,
              objective           : objectives[i],
              status              : 'PAUSED',
              special_ad_categories: [],
              access_token        : biz.meta_access_token
            });
          if (metaResp.body?.id && saved?.id) {
            await sbPatch('ad_campaigns', `id=eq.${saved.id}`, { meta_campaign_id: metaResp.body.id, status: 'active' });
          }
        } catch (e) { log('/webhook/create-campaigns', `Meta API warn: ${e.message}`); }
      }
    }

    try { storeInsight(business_id, 'ads', 'ad_strategy', 'campaign_count', `${savedIds.length} campaigns created`); } catch {}
    log('/webhook/create-campaigns', `✅ Created ${savedIds.length} campaigns`);

    if (biz.email) {
      const html = `<h2>Your Ad Campaigns Are Ready!</h2>
<p>We've created 3 optimized Meta ad campaigns for <strong>${biz.business_name}</strong>:</p>
<ul><li>Awareness Campaign (40% budget)</li><li>Engagement Campaign (25% budget)</li><li>Retargeting Campaign (35% budget)</li></ul>
<p>All campaigns are set to PAUSED — activate them when ready in your dashboard.</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Manage Campaigns</a></p>`;
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
  logger.info('/webhook/content-approved', business_id || null, 'webhook received', { content_id, request_id: req.requestId });

  if (!content_id) return apiError(res, 400, 'VALIDATION_ERROR', 'content_id required');

  // Return immediately — DB update + publishing happen in background
  res.json({ received: true, message: 'Approved — autopublish in progress' });

  setImmediate(async () => {
  try {
    await sbPatch('generated_content', `id=eq.${content_id}`, {
      status: 'approved', approved_at: new Date().toISOString(),
      approval_method: approval_method || 'manual'
    });

    const [bizArr, contentArr] = await Promise.all([
      sbGet('businesses', `id=eq.${business_id}&select=*`),
      sbGet('generated_content', `id=eq.${content_id}&select=*`)
    ]);
    const biz  = bizArr[0];
    const cont = contentArr[0];
    if (!biz || !cont) { log('/webhook/content-approved', 'biz/content not found — skipping publish'); return; }

    const platforms = (() => { try { return JSON.parse(biz.selected_platforms || '[]'); } catch { return []; } })();
    const published = [];

    // ── Publish to Facebook ───────────────────────────────────────────────────
    if (biz.autopilot_enabled && biz.meta_access_token && biz.facebook_page_id &&
        (platforms.includes('facebook') || platforms.length === 0)) {
      try {
        const fbResp = await apiRequest('POST',
          `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/feed`,
          { 'Content-Type': 'application/json' },
          {
            message      : cont.facebook_post || cont.instagram_caption,
            access_token : biz.meta_access_token,
            ...(cont.image_url ? { link: cont.image_url } : {})
          });
        if (fbResp.body?.id) { published.push('Facebook'); log('/webhook/content-approved', `FB posted: ${fbResp.body.id}`); }
      } catch (e) { log('/webhook/content-approved', `FB warn: ${e.message}`); }
    }

    // ── Publish to Instagram ──────────────────────────────────────────────────
    if (biz.autopilot_enabled && biz.meta_access_token && biz.instagram_account_id &&
        (platforms.includes('instagram') || platforms.length === 0)) {
      try {
        if (cont.image_url) {
          const step1 = await apiRequest('POST',
            `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media`,
            { 'Content-Type': 'application/json' },
            { image_url: cont.image_url, caption: cont.instagram_caption, access_token: biz.meta_access_token });

          if (step1.body?.id) {
            const step2 = await apiRequest('POST',
              `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media_publish`,
              { 'Content-Type': 'application/json' },
              { creation_id: step1.body.id, access_token: biz.meta_access_token });
            if (step2.body?.id) { published.push('Instagram'); log('/webhook/content-approved', `IG posted: ${step2.body.id}`); }
          }
        }
      } catch (e) { log('/webhook/content-approved', `IG warn: ${e.message}`); }
    }

    if (published.length > 0) {
      await sbPatch('generated_content', `id=eq.${content_id}`, {
        status: 'published', published_at: new Date().toISOString() });
      await sbPatch('businesses', `id=eq.${business_id}`,
        { posts_published: (biz.posts_published || 0) + 1 });
      await sbPost('retention_logs', { business_id, email_type: 'content_published',
        subject: `Published: ${cont.content_theme || 'content'} to ${published.join(', ')}` });
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
      sbGet('ad_campaigns', `business_id=eq.${business_id}&status=eq.active&select=*`)
    ]);
    const biz = bizArr[0];

    // Distribute budget: 40% awareness, 35% retargeting, 25% engagement
    const splits = { awareness: 0.40, retargeting: 0.35, engagement: 0.25 };
    const dailyCents = Math.round(budget * 100);

    for (const camp of campaigns) {
      const name = (camp.last_decision_reason || '').toLowerCase();
      const split = name.includes('aware') ? splits.awareness :
                    name.includes('retarget') ? splits.retargeting : splits.engagement;
      const campBudget = Math.max(1, Math.round(budget * split));

      await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { daily_budget: campBudget });

      if (biz?.meta_access_token && camp.meta_campaign_id) {
        try {
          await apiRequest('POST',
            `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}`,
            { 'Content-Type': 'application/json' },
            { daily_budget: campBudget * 100, access_token: biz.meta_access_token });
        } catch (e) { log('/webhook/budget-updated', `Meta update warn: ${e.message}`); }
      }
    }

    if (biz?.email) {
      const html = `<h2>Budget Updated to $${budget}/day</h2>
<p>Your ad spend has been updated and distributed across your campaigns:</p>
<ul><li>Awareness: $${Math.round(budget * 0.40)}/day (40%)</li>
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
    const compNames   = typeof competitors === 'string' ? competitors.split(',').slice(0, 3) : [competitors];

    let compData = '';
    for (const comp of compNames) {
      const r1 = await serpSearch(`${comp.trim()} social media marketing posts`, 3);
      const r2 = await serpSearch(`${comp.trim()} Instagram content`, 2);
      compData += `\n${comp.trim()}:\n` + [...r1, ...r2].map(r => `- ${r.title}: ${r.snippet}`).join('\n');
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
      'research', 1500
    );

    if (insights && !insights._raw) {
      await sbPost('competitor_insights', {
        business_id,
        competitor_doing_well : insights.competitor_doing_well || '',
        gap_opportunity       : insights.gap_opportunity       || '',
        content_to_steal      : insights.content_to_steal      || '',
        positioning_tip       : insights.positioning_tip       || ''
      });
      try { storeInsight(business_id, 'competitors', 'competitive_intelligence', 'competitor_weakness', insights.gap_opportunity || ''); storeInsight(business_id, 'competitors', 'competitive_intelligence', 'our_advantage', insights.positioning_tip || ''); } catch {}
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

  try {
    const [bizArr, campArr] = await Promise.all([
      sbGet('businesses', `id=eq.${business_id}&select=*`),
      campaign_id ? sbGet('ad_campaigns', `id=eq.${campaign_id}&select=*`) : Promise.resolve([])
    ]);
    const biz  = bizArr[0];
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
      'campaign', 1500
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
  ${(page.form_fields || ['Name', 'Email', 'Phone']).map(f => `<input type="text" placeholder="${f}">`).join('\n  ')}
  <button type="submit">${page.hero_cta || 'Get Started'}</button>
</div>
</body></html>`;

    // Save to landing_pages table
    let savedId = null;
    try {
      const saved = await sbPost('landing_pages', {
        business_id,
        campaign_id   : campaign_id || null,
        hero_headline : page.hero_headline || '',
        hero_subheadline: page.hero_subheadline || '',
        hero_cta      : page.hero_cta || '',
        value_props   : JSON.stringify([page.value_prop_1, page.value_prop_2, page.value_prop_3]),
        social_proof  : page.testimonial || '',
        testimonials  : JSON.stringify([{ quote: page.testimonial, name: page.testimonial_name, role: page.testimonial_role }]),
        closing_headline: page.urgency || '',
        closing_cta   : page.hero_cta || '',
        html_content  : html,
        status        : 'draft'
      });
      savedId = saved?.id;
    } catch {}

    // Send email with HTML
    if (biz.email) {
      const emailHtml = `<h2>Your Landing Page is Ready!</h2>
<p>We've created a high-converting landing page for <strong>${biz.business_name}</strong>.</p>
<p><strong>Headline:</strong> ${page.hero_headline}</p>
<p><strong>CTA:</strong> ${page.hero_cta}</p>
<h3>Copy the HTML code below and paste it into your website:</h3>
<pre style="background:#f5f5f5;padding:20px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap">${html.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
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
app.post('/test-email', async (req, res) => {
  const to     = req.body?.email;
  const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
  const from   = clean(process.env.FROM_EMAIL)     || FROM_EMAIL;

  if (!to) return res.status(400).json({ error: 'email field required' });

  if (!apiKey) return res.status(500).json({
    error : 'RESEND_API_KEY is not set',
    fix   : '1. Sign up free at resend.com  2. Get API key  3. Add RESEND_API_KEY to Railway env vars  4. Optionally add FROM_EMAIL (verified domain) — default is onboarding@resend.dev'
  });

  const result = await sendEmail(to, 'maroa.ai — email test ✅',
    '<p>This is a test email from your Maroa.ai server. Email sending via Resend is working correctly!</p>');

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
app.post('/meta-oauth-exchange', async (req, res) => {
  const { code, business_id, redirect_uri } = req.body;
  if (!code || !business_id) return res.status(400).json({ error: 'code and business_id required' });

  const APP_ID     = clean(process.env.META_APP_ID)     || '26551713411132003';
  const APP_SECRET = clean(process.env.META_APP_SECRET) || '';
  const REDIRECT   = redirect_uri || 'https://maroa-ai-marketing-automator.vercel.app/social-callback';

  // Guard: fail immediately if secret is missing — saves a confusing Facebook error
  if (!APP_SECRET) {
    log('/meta-oauth-exchange', 'META_APP_SECRET is not set in Railway env vars');
    return res.status(500).json({
      error      : 'META_APP_SECRET is not configured on the server',
      fix        : 'Go to Railway → your project → Variables → add META_APP_SECRET with your Meta app secret',
      redirect_uri: REDIRECT,
      app_id     : APP_ID
    });
  }

  log('/meta-oauth-exchange', `Starting exchange — app_id=${APP_ID} redirect_uri=${REDIRECT}`);

  try {
    // 1. Exchange code for user access token
    const tokenUrl  = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`;
    log('/meta-oauth-exchange', `Token exchange URL (no secret): client_id=${APP_ID}&redirect_uri=${REDIRECT}`);
    const tokenResp = await apiRequest('GET', tokenUrl);

    if (!tokenResp.body?.access_token) {
      const fbError = tokenResp.body?.error || tokenResp.body;
      log('/meta-oauth-exchange', `Token exchange failed: ${JSON.stringify(fbError)}`);
      return res.status(400).json({
        error       : 'Token exchange failed',
        fb_error    : fbError,
        redirect_uri: REDIRECT,
        app_id      : APP_ID,
        hint        : 'Make sure redirect_uri exactly matches what is registered in Meta App Dashboard → Facebook Login → Valid OAuth Redirect URIs'
      });
    }

    const userToken = tokenResp.body.access_token;
    log('/meta-oauth-exchange', `User token obtained for business_id=${business_id}`);

    // 2. Get long-lived user token (optional but better than short-lived)
    let longToken = userToken;
    try {
      const llResp = await apiRequest('GET',
        `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${userToken}`);
      if (llResp.body?.access_token) longToken = llResp.body.access_token;
    } catch {}

    // 3. Get pages + page access token
    const pagesResp = await apiRequest('GET',
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}&fields=id,name,access_token,fan_count`);
    const pages = pagesResp.body?.data || [];

    if (pages.length === 0) {
      log('/meta-oauth-exchange', `No pages found for business_id=${business_id}`);
      return res.status(400).json({ error: 'No Facebook pages found. Make sure you have a Business page.' });
    }

    const page      = pages[0];
    const pageToken = page.access_token;
    const pageId    = page.id;

    // 4. Get Instagram ID via debug_token granular_scopes (most reliable)
    let igId = null;
    const debugResp = await apiRequest('GET',
      `https://graph.facebook.com/v19.0/debug_token?input_token=${pageToken}&access_token=${pageToken}`);
    const granular = debugResp.body?.data?.granular_scopes || [];
    const igScope  = granular.find(s => s.scope === 'instagram_basic');
    igId = igScope?.target_ids?.[0] || null;

    // Fallback: page fields
    if (!igId) {
      const igPageResp = await apiRequest('GET',
        `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account,connected_instagram_account&access_token=${pageToken}`);
      igId = igPageResp.body?.instagram_business_account?.id
          || igPageResp.body?.connected_instagram_account?.id
          || null;
    }

    // 5. Save to Supabase
    const updates = {
      meta_access_token   : pageToken,
      facebook_page_id    : pageId,
      social_accounts_connected: true
    };
    if (page.fan_count) updates.followers_gained = page.fan_count;
    if (igId)           updates.instagram_account_id = igId;

    await sbPatch('businesses', `id=eq.${business_id}`, updates);

    // 6. Fire account-connected logic (campaigns + email)
    setImmediate(async () => {
      try {
        await apiRequest('POST', `http://localhost:${PORT}/webhook/account-connected`,
          { 'Content-Type': 'application/json' },
          { business_id, meta_access_token: pageToken, facebook_page_id: pageId });
      } catch {}
    });

    log('/meta-oauth-exchange', `✅ Saved page=${pageId} ig=${igId || 'none'} for business_id=${business_id}`);

    res.json({
      success           : true,
      facebook_page_id  : pageId,
      facebook_page_name: page.name,
      instagram_id      : igId || null,
      message           : `Connected: Facebook (${page.name})${igId ? ' + Instagram' : ''}`
    });

  } catch (err) {
    console.error('[meta-oauth-exchange ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// BUILD 1 — BILLING + PLAN GATES
// Plans: starter(€29) · growth(€59) · agency(€99)
// ═════════════════════════════════════════════════════════════════════════════

const PLANS = {
  starter: {
    name: 'Starter', price: 29, annual: 290, maxRuns: 1, runHours: [6],
    priceId: PADDLE_STARTER_PRICE,
    images: 20, kling: 0, sora: 0, platforms: 1, brands: 1,
    video: false, analytics: false, white_label: false, api: false,
    features: ['1 platform', '20 AI images/mo', 'AI brain 1×/day', 'Content calendar', 'Email support'],
  },
  growth: {
    name: 'Growth', price: 59, annual: 590, maxRuns: 3, runHours: [6, 12, 18],
    priceId: PADDLE_GROWTH_PRICE,
    images: 60, kling: 25, sora: 5, platforms: 3, brands: 1,
    video: true, analytics: true, white_label: false, api: false,
    features: ['3 platforms', '60 AI images/mo', '25 Kling videos', '5 Sora videos', 'AI brain 3×/day', 'Paid ads', 'Competitor tracking', 'Analytics'],
  },
  agency: {
    name: 'Agency', price: 99, annual: 990, maxRuns: 5, runHours: [6, 9, 12, 15, 18],
    priceId: PADDLE_AGENCY_PRICE,
    images: 120, kling: 50, sora: 15, platforms: 99, brands: 3,
    video: true, analytics: true, white_label: true, api: true,
    features: ['Unlimited platforms', '120 AI images/mo', '50 Kling videos', '15 Sora videos', 'AI brain 5×/day', '3 brands', 'White-label', 'API access'],
  },
  // Legacy alias
  free: {
    name: 'Starter', price: 29, annual: 290, maxRuns: 1, runHours: [6],
    priceId: PADDLE_STARTER_PRICE,
    images: 20, kling: 0, sora: 0, platforms: 1, brands: 1,
    video: false, analytics: false, white_label: false, api: false,
    features: ['1 platform', '20 AI images/mo'],
  },
};

// GET /api/billing/plans — public, no auth needed
app.get('/api/billing/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// POST /api/checkout — create Paddle checkout session
// Body: { user_id, plan }
app.post('/api/checkout', async (req, res) => {
  const { user_id, plan, success_url } = req.body;
  if (!user_id || !plan) return res.status(400).json({ error: 'user_id and plan required' });

  if (!paddle.PADDLE_API_KEY) return res.status(500).json({ error: 'PADDLE_API_KEY not set in Railway env vars' });

  const planObj = PLANS[plan];
  if (!planObj)         return res.status(400).json({ error: `Unknown plan: ${plan}. Valid: starter, growth, agency` });
  if (!planObj.priceId) return res.status(400).json({ error: `No Paddle price ID for "${plan}". Set PADDLE_${plan.toUpperCase()}_PRICE_ID in Railway.` });

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
      successUrl: success_url || 'https://maroa-ai-marketing-automator.vercel.app/dashboard?upgraded=true',
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
  return app._router.handle(Object.assign(req, { url: '/api/checkout', originalUrl: '/api/checkout' }), res, () => {});
});

// ═════════════════════════════════════════════════════════════════════════════
// BUILD 2 — AGENCY MULTI-WORKSPACE
// All routes use planGate('multi_workspace') — agency plan only
// ═════════════════════════════════════════════════════════════════════════════

// POST /webhook/org-create
// Body: { business_id, name }
app.post('/webhook/org-create', planGate('multi_workspace'), async (req, res) => {
  const { business_id, name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json({ received: true, message: 'Creating organization' });

  try {
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=user_id,email`))[0];
    if (!biz) return;

    const org = await sbPost('organizations', {
      name, owner_user_id: biz.user_id || null, plan: 'agency'
    });
    if (biz.user_id && org?.id) {
      await sbPost('organization_members', {
        organization_id: org.id, user_id: biz.user_id, role: 'owner'
      });
    }
    if (org?.id) {
      await sbPatch('businesses', `id=eq.${business_id}`, { organization_id: org.id });
    }
    log('/webhook/org-create', `Org "${name}" created — id: ${org?.id}`);
  } catch (err) {
    console.error('[org-create ERROR]', err.message);
    await logError(business_id, 'org-create', err.message, req.body);
  }
});

// GET /webhook/org-get?org_id=...&business_id=...
app.get('/webhook/org-get', async (req, res) => {
  const org_id = req.query.org_id || req.query.organization_id;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });
  try {
    const org        = (await sbGet('organizations',       `id=eq.${org_id}`))[0];
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const members    = await sbGet('organization_members', `organization_id=eq.${org_id}`);
    const workspaces = await sbGet('workspaces',           `organization_id=eq.${org_id}`);
    res.json({ organization: org, members, workspaces, workspace_count: workspaces.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/org-add-workspace
// Body: { business_id, org_id, name, client_name? }
app.post('/webhook/org-add-workspace', planGate('multi_workspace'), async (req, res) => {
  const { business_id, org_id, name, client_name } = req.body;
  if (!org_id || !name) return res.status(400).json({ error: 'org_id and name required' });
  res.json({ received: true, message: 'Adding workspace' });

  try {
    const existing = await sbGet('workspaces', `organization_id=eq.${org_id}&select=id`);
    if (existing.length >= 20) {
      return log('/webhook/org-add-workspace', `Workspace limit reached for org ${org_id}`);
    }
    const ws = await sbPost('workspaces', {
      organization_id: org_id, business_id: business_id || null,
      name, client_name: client_name || name, is_active: true
    });
    if (business_id && ws?.id) {
      await sbPatch('businesses', `id=eq.${business_id}`, {
        organization_id: org_id, workspace_id: ws.id
      });
    }
    log('/webhook/org-add-workspace', `Workspace "${name}" added to org ${org_id}`);
  } catch (err) {
    console.error('[org-add-workspace ERROR]', err.message);
    await logError(business_id, 'org-add-workspace', err.message, req.body);
  }
});

// POST /webhook/org-invite-member
// Body: { business_id, org_id, email, role }
app.post('/webhook/org-invite-member', planGate('multi_workspace'), async (req, res) => {
  const { business_id, org_id, email, role = 'member' } = req.body;
  if (!org_id || !email) return res.status(400).json({ error: 'org_id and email required' });
  res.json({ received: true, message: `Invite sent to ${email}` });

  try {
    const org = (await sbGet('organizations', `id=eq.${org_id}&select=name`))[0];
    await sbPost('organization_members', {
      organization_id: org_id, user_id: null, role
    });
    const html = `<h2>You've been invited to ${org?.name || 'a maroa.ai workspace'}</h2>
<p>You've been added as a <strong>${role}</strong>. Click below to accept:</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/accept-invite?org=${org_id}&email=${encodeURIComponent(email)}"
   style="background:#667eea;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
   Accept Invitation
</a></p>`;
    await sendEmail(email, `You've been invited to ${org?.name || 'maroa.ai'}`, html);
    log('/webhook/org-invite-member', `Invited ${email} as ${role} to org ${org_id}`);
  } catch (err) {
    console.error('[org-invite-member ERROR]', err.message);
  }
});

// POST /webhook/org-white-label-update
// Body: { business_id, org_id, white_label_logo_url?, white_label_primary_color?, white_label_company_name?, white_label_domain? }
app.post('/webhook/org-white-label-update', planGate('white_label'), async (req, res) => {
  const { org_id } = req.body;
  if (!org_id) return res.status(400).json({ error: 'org_id required' });

  const fields  = ['white_label_logo_url','white_label_primary_color','white_label_company_name','white_label_domain'];
  const updates = {};
  fields.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No white-label fields provided', accepted: fields });

  try {
    await sbPatch('organizations', `id=eq.${org_id}`, updates);
    log('/webhook/org-white-label-update', `White-label updated for org ${org_id}`);
    res.json({ received: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BUILD 3 — LINKEDIN AUTOPILOT
// Modelled exactly on /meta-oauth-exchange
// ═════════════════════════════════════════════════════════════════════════════

const LINKEDIN_CLIENT_ID     = (process.env.LINKEDIN_CLIENT_ID     || '').replace(/[^\x20-\x7E]/g,'').trim();
const LINKEDIN_CLIENT_SECRET = (process.env.LINKEDIN_CLIENT_SECRET || '').replace(/[^\x20-\x7E]/g,'').trim();
const LINKEDIN_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.vercel.app/social-callback';

// GET /linkedin-oauth-start — redirect user to LinkedIn consent screen
app.get('/linkedin-oauth-start', (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!LINKEDIN_CLIENT_ID) return res.status(500).json({ error: 'LINKEDIN_CLIENT_ID not configured' });

  const scope = 'openid profile email w_member_social';
  const state = `${business_id}:linkedin`;
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}`;

  log('/linkedin-oauth-start', `Redirecting business_id=${business_id} to LinkedIn`);
  res.redirect(authUrl);
});

// POST /webhook/linkedin-oauth-exchange
// Called by /social-callback with { code, business_id, redirect_uri? }
app.post('/webhook/linkedin-oauth-exchange', async (req, res) => {
  const { code, business_id, redirect_uri } = req.body;
  if (!code || !business_id) return res.status(400).json({ error: 'code and business_id required' });

  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET not set in Railway',
      fix:   'Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to Railway environment variables'
    });
  }

  const REDIRECT = redirect_uri || LINKEDIN_REDIRECT_URI;
  log('/webhook/linkedin-oauth-exchange', `Starting exchange for business_id=${business_id} redirect=${REDIRECT}`);

  try {
    // 1. Exchange code for access token
    const tokenParams = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT,
      client_id:     LINKEDIN_CLIENT_ID,
      client_secret: LINKEDIN_CLIENT_SECRET,
    });
    const tokenResp = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    tokenParams.toString()
    });
    const tokenData = await tokenResp.json();

    if (!tokenData.access_token) {
      log('/webhook/linkedin-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
      return res.status(400).json({
        error:        'LinkedIn token exchange failed',
        detail:       tokenData,
        redirect_uri: REDIRECT,
        hint:         'Verify LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and redirect_uri match your LinkedIn app settings'
      });
    }

    const accessToken  = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;

    // 2. Get person profile (OpenID)
    const profileResp = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const profile = await profileResp.json();
    const personId = profile.sub || null;

    // 3. Get organization (company page) the user admins
    let orgId = null;
    try {
      const orgResp = await fetch(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName)))',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const orgData = await orgResp.json();
      if (orgData?.elements?.[0]) {
        orgId = String(orgData.elements[0]['organization~']?.id || '');
      }
    } catch {}

    // 4. Save to Supabase
    const updates = {
      linkedin_access_token:    accessToken,
      linkedin_refresh_token:   refreshToken,
      linkedin_person_id:       personId,
      linkedin_organization_id: orgId,
      linkedin_connected:       true,
    };
    await sbPatch('businesses', `id=eq.${business_id}`, updates);

    log('/webhook/linkedin-oauth-exchange', `✅ LinkedIn connected for ${business_id} — person: ${profile.name}, org: ${orgId}`);
    res.json({
      success:                  true,
      linkedin_person_id:       personId,
      linkedin_organization_id: orgId,
      name:                     profile.name,
      message:                  `LinkedIn connected${orgId ? ' (company page found)' : ' (personal profile)'}`
    });

  } catch (err) {
    console.error('[linkedin-oauth-exchange ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/linkedin-publish
// Body: { business_id, content? }  — content = 'AI_GENERATE' or actual text
app.post('/webhook/linkedin-publish', async (req, res) => {
  const { business_id, content } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'LinkedIn publish started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,linkedin_access_token,linkedin_person_id,linkedin_organization_id`))[0];
    if (!biz?.linkedin_access_token) {
      return log('/webhook/linkedin-publish', `LinkedIn not connected for ${business_id}`);
    }

    // 1. Generate post with Claude Sonnet if not provided
    let postText = content;
    if (!postText || postText === 'AI_GENERATE') {
      const bestThemes = biz.best_performing_themes ? JSON.stringify(biz.best_performing_themes) : 'not available yet';
      const brandContext = await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} linkedin`);
      const prompt = `${brandContext}You are a LinkedIn content expert. Generate a professional LinkedIn post for a ${biz.industry} business.
Business: ${biz.business_name}
Tone: ${biz.brand_tone || 'professional and approachable'}
Target audience: ${biz.target_audience || 'business owners'}
Dream customer: ${biz.dream_customer || ''}
Unique differentiator: ${biz.unique_differentiator || ''}
Best performing themes: ${bestThemes}

Write a post with: hook (first line stops scrolling), value body (3-5 lines), CTA, 3-5 hashtags.
Plain text, no markdown, no asterisks. Max 1300 characters.
Return only valid JSON: {"post_text":"...","content_theme":"..."}`;

      const aiResp = await apiRequest('POST', 'https://api.anthropic.com/v1/messages',
        { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        { model: 'claude-opus-4-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] });

      const raw = aiResp.body?.content?.[0]?.text || '{}';
      const parsed = extractJSON(raw) || {};
      postText = parsed.post_text || raw;

      // Save to generated_content
      await sbPost('generated_content', {
        business_id,
        linkedin_post:  postText,
        content_theme:  parsed.content_theme || 'linkedin',
        status:         'published',
        published_at:   new Date().toISOString()
      });
    }

    // 2. Determine author URN
    const authorUrn = biz.linkedin_organization_id
      ? `urn:li:organization:${biz.linkedin_organization_id}`
      : `urn:li:person:${biz.linkedin_person_id}`;

    // 3. Post via LinkedIn UGC Posts API
    const ugcPost = {
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary:    { text: postText },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    };

    const publishResp = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method:  'POST',
      headers: {
        Authorization:               `Bearer ${biz.linkedin_access_token}`,
        'Content-Type':              'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(ugcPost)
    });
    const publishData = await publishResp.json();

    if (publishData.id) {
      // Update next post date
      await sbPatch('businesses', `id=eq.${business_id}`, {
        next_linkedin_post_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      });
      log('/webhook/linkedin-publish', `✅ Published to LinkedIn for ${business_id}: ${publishData.id}`);
    } else {
      log('/webhook/linkedin-publish', `LinkedIn publish failed: ${JSON.stringify(publishData)}`);
      await logError(business_id, 'linkedin-publish', JSON.stringify(publishData), req.body);
    }

  } catch (err) {
    console.error('[linkedin-publish ERROR]', err.message);
    await logError(business_id, 'linkedin-publish', err.message, req.body);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BUILD 4 — X (TWITTER) AUTOPILOT — OAuth 2.0 PKCE
// ═════════════════════════════════════════════════════════════════════════════

const TWITTER_CLIENT_ID     = (process.env.TWITTER_CLIENT_ID     || '').replace(/[^\x20-\x7E]/g,'').trim();
const TWITTER_CLIENT_SECRET = (process.env.TWITTER_CLIENT_SECRET || '').replace(/[^\x20-\x7E]/g,'').trim();
const TWITTER_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.vercel.app/social-callback';

// GET /twitter-oauth-start — redirect user to Twitter consent screen (PKCE)
app.get('/twitter-oauth-start', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!TWITTER_CLIENT_ID) return res.status(500).json({ error: 'TWITTER_CLIENT_ID not configured' });

  const state = `${business_id}:twitter`;
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Store code_verifier so the exchange route can use it later
  try {
    await sbPost('oauth_states', { business_id, platform: 'twitter', state, code_verifier: codeVerifier });
  } catch (err) { log('/twitter-oauth-start', `Failed to store PKCE state: ${err.message}`); }

  const authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${TWITTER_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITTER_REDIRECT_URI)}&scope=${encodeURIComponent('tweet.read tweet.write users.read offline.access')}&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  log('/twitter-oauth-start', `Redirecting business_id=${business_id} to Twitter`);
  res.redirect(authUrl);
});

// POST /webhook/twitter-oauth-exchange
// Body: { code, business_id, code_verifier, redirect_uri? }
app.post('/webhook/twitter-oauth-exchange', async (req, res) => {
  const { code, business_id, code_verifier, redirect_uri } = req.body;
  if (!code || !business_id || !code_verifier) {
    return res.status(400).json({ error: 'code, business_id, and code_verifier required' });
  }

  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'TWITTER_CLIENT_ID or TWITTER_CLIENT_SECRET not set in Railway',
      fix:   'Add TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET to Railway environment variables'
    });
  }

  const REDIRECT = redirect_uri || TWITTER_REDIRECT_URI;
  log('/webhook/twitter-oauth-exchange', `Starting exchange for business_id=${business_id}`);

  try {
    // 1. Exchange code + PKCE verifier for access token
    const basicAuth = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64');
    const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT,
        code_verifier,
        client_id:     TWITTER_CLIENT_ID,
      }).toString()
    });
    const tokenData = await tokenResp.json();

    if (!tokenData.access_token) {
      log('/webhook/twitter-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
      return res.status(400).json({
        error:   'Twitter token exchange failed',
        detail:  tokenData,
        hint:    'Ensure redirect_uri matches what is registered in Twitter Developer Portal and code_verifier matches the challenge used'
      });
    }

    // 2. Get user info
    const userResp = await fetch('https://api.twitter.com/2/users/me?user.fields=username,name', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userResp.json();
    const twitterUser = userData.data || {};

    // 3. Save to Supabase
    await sbPatch('businesses', `id=eq.${business_id}`, {
      twitter_access_token:  tokenData.access_token,
      twitter_refresh_token: tokenData.refresh_token || null,
      twitter_user_id:       twitterUser.id       || null,
      twitter_connected:     true,
    });

    log('/webhook/twitter-oauth-exchange', `✅ Twitter connected for ${business_id} — @${twitterUser.username}`);
    res.json({
      success:          true,
      twitter_user_id:  twitterUser.id,
      twitter_username: twitterUser.username,
      message:          `Twitter connected as @${twitterUser.username}`
    });

  } catch (err) {
    console.error('[twitter-oauth-exchange ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/twitter-publish
// Body: { business_id, text? }
app.post('/webhook/twitter-publish', async (req, res) => {
  const { business_id, text, post_type = 'tweet' } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: `Twitter ${post_type} started` });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,twitter_access_token,twitter_user_id`))[0];
    if (!biz?.twitter_access_token) {
      return log('/webhook/twitter-publish', `Twitter not connected for ${business_id}`);
    }

    let tweetText = text;
    let tweets    = [];

    if (!tweetText || tweetText === 'AI_GENERATE') {
      const isThread = post_type === 'thread';
      const brandContext = await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} twitter`);
      const prompt = isThread
        ? `${brandContext}Write a 5-tweet thread for a ${biz.industry} business.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'expert'}.
Tweet 1: bold hook. Tweets 2-4: actionable value. Tweet 5: CTA.
Max 270 chars each. Max 1-2 hashtags total across the thread.
Return only valid JSON: {"tweets":["t1","t2","t3","t4","t5"],"content_theme":"..."}`
        : `${brandContext}Generate a tweet for a ${biz.industry} business. Max 280 characters.
Direct, engaging, ends with soft CTA. Max 2 hashtags.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'professional'}, Audience: ${biz.target_audience || 'business owners'}.
Return only valid JSON: {"tweet":"...","content_theme":"..."}`;

      const aiResp = await apiRequest('POST', 'https://api.anthropic.com/v1/messages',
        { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        { model: 'claude-opus-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });

      const raw = aiResp.body?.content?.[0]?.text || '{}';
      const parsed = extractJSON(raw) || {};

      tweetText = parsed.tweet     || '';
      tweets    = parsed.tweets    || [];
      const contentTheme = parsed.content_theme || 'twitter';

      // Save to generated_content
      await sbPost('generated_content', {
        business_id,
        twitter_post:  isThread ? tweets.join('\n---\n') : tweetText,
        content_theme: contentTheme,
        status:        'published',
        published_at:  new Date().toISOString()
      });
    }

    // Post single tweet
    if (!tweets.length) tweets = [tweetText];
    const isThread = tweets.length > 1;

    let previousId = null;
    const postedIds = [];
    for (const t of tweets) {
      const body = { text: (t || '').slice(0, 280) };
      if (previousId) body.reply = { in_reply_to_tweet_id: previousId };

      const tweetResp = await fetch('https://api.twitter.com/2/tweets', {
        method:  'POST',
        headers: { Authorization: `Bearer ${biz.twitter_access_token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
      });
      const tweetData = await tweetResp.json();
      if (tweetData.data?.id) { postedIds.push(tweetData.data.id); previousId = tweetData.data.id; }
    }

    if (postedIds.length) {
      await sbPatch('businesses', `id=eq.${business_id}`, {
        next_twitter_post_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
      log('/webhook/twitter-publish', `✅ Posted ${isThread ? `thread (${postedIds.length} tweets)` : 'tweet'} for ${business_id}`);
    } else {
      log('/webhook/twitter-publish', `Twitter post failed — no IDs returned`);
    }

  } catch (err) {
    console.error('[twitter-publish ERROR]', err.message);
    await logError(business_id, 'twitter-publish', err.message, req.body);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BUILD 5 — TIKTOK AUTOPILOT
// ═════════════════════════════════════════════════════════════════════════════

const TIKTOK_CLIENT_KEY    = (process.env.TIKTOK_CLIENT_KEY    || '').replace(/[^\x20-\x7E]/g,'').trim();
const TIKTOK_CLIENT_SECRET = (process.env.TIKTOK_CLIENT_SECRET || '').replace(/[^\x20-\x7E]/g,'').trim();
const TIKTOK_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.vercel.app/social-callback';

// GET /tiktok-oauth-start — redirect user to TikTok consent screen (PKCE)
app.get('/tiktok-oauth-start', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!TIKTOK_CLIENT_KEY) return res.status(500).json({ error: 'TIKTOK_CLIENT_KEY not configured' });

  const state = `${business_id}:tiktok`;
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Store code_verifier so the exchange route can use it later
  try {
    await sbPost('oauth_states', { business_id, platform: 'tiktok', state, code_verifier: codeVerifier });
  } catch (err) { log('/tiktok-oauth-start', `Failed to store PKCE state: ${err.message}`); }

  const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${TIKTOK_CLIENT_KEY}&response_type=code&scope=${encodeURIComponent('user.info.basic,video.upload,video.list')}&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}&state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  log('/tiktok-oauth-start', `Redirecting business_id=${business_id} to TikTok`);
  res.redirect(authUrl);
});

// POST /webhook/tiktok-oauth-exchange
// Body: { code, business_id, code_verifier, redirect_uri? }
app.post('/webhook/tiktok-oauth-exchange', async (req, res) => {
  const { code, business_id, code_verifier, redirect_uri } = req.body;
  if (!code || !business_id || !code_verifier) {
    return res.status(400).json({ error: 'code, business_id, and code_verifier required' });
  }

  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    return res.status(500).json({
      error: 'TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET not set in Railway',
      fix:   'Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to Railway environment variables'
    });
  }

  const REDIRECT = redirect_uri || TIKTOK_REDIRECT_URI;
  log('/webhook/tiktok-oauth-exchange', `Starting exchange for business_id=${business_id}`);

  try {
    // 1. Exchange code for token
    const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_key:    TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT,
        code_verifier,
      }).toString()
    });
    const tokenData = await tokenResp.json();

    if (!tokenData.data?.access_token) {
      log('/webhook/tiktok-oauth-exchange', `Token exchange failed: ${JSON.stringify(tokenData)}`);
      return res.status(400).json({
        error:  'TikTok token exchange failed',
        detail: tokenData,
        hint:   'Ensure redirect_uri matches TikTok app settings and code_verifier matches the challenge'
      });
    }

    const access_token  = tokenData.data.access_token;
    const refresh_token = tokenData.data.refresh_token || null;

    // 2. Get user info
    let userId = null;
    try {
      const userResp = await fetch(
        'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username',
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const ud = await userResp.json();
      userId = ud?.data?.user?.open_id || null;
    } catch {}

    // 3. Save to Supabase
    await sbPatch('businesses', `id=eq.${business_id}`, {
      tiktok_access_token:  access_token,
      tiktok_refresh_token: refresh_token,
      tiktok_user_id:       userId,
      tiktok_connected:     true,
    });

    log('/webhook/tiktok-oauth-exchange', `✅ TikTok connected for ${business_id} — user_id: ${userId}`);
    res.json({ success: true, tiktok_user_id: userId, message: 'TikTok connected' });

  } catch (err) {
    console.error('[tiktok-oauth-exchange ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /webhook/tiktok-publish
// Body: { business_id, video_url? }
app.post('/webhook/tiktok-publish', async (req, res) => {
  const { business_id, video_url } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'TikTok script generation started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,brand_tone,target_audience,dream_customer,unique_differentiator,best_performing_themes,tiktok_access_token,tiktok_user_id`))[0];
    if (!biz?.tiktok_access_token) {
      return log('/webhook/tiktok-publish', `TikTok not connected for ${business_id}`);
    }

    // 1. Generate script + caption via Claude Sonnet
    const bestThemes = biz.best_performing_themes ? JSON.stringify(biz.best_performing_themes) : 'not available yet';
    const brandContext = await getBrandExamples(business_id, 'social_post', `${biz.business_name} ${biz.industry} tiktok video`);
    const prompt = `${brandContext}Write a TikTok video script for a ${biz.industry} business.
Business: ${biz.business_name}
Tone: ${biz.brand_tone || 'fun, energetic, authentic'}
Target audience: ${biz.target_audience || 'young adults'}
Dream customer: ${biz.dream_customer || ''}
Unique differentiator: ${biz.unique_differentiator || ''}
Best performing themes: ${bestThemes}

Script format:
- Hook (0-3 sec): bold statement or question that stops the scroll
- Problem (3-8 sec): relatable pain point your audience feels
- Solution (8-20 sec): how ${biz.business_name} solves it
- CTA (last 3 sec): one clear action (follow, comment, DM)

Also write:
- Caption: max 150 characters, punchy and curiosity-driven
- 5 trending hashtags for ${biz.industry}

Return only valid JSON: {"hook":"...","script":"...","caption":"...","hashtags":["#tag1","#tag2","#tag3","#tag4","#tag5"],"content_theme":"..."}`;

    const aiResp = await apiRequest('POST', 'https://api.anthropic.com/v1/messages',
      { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      { model: 'claude-opus-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });

    const raw = aiResp.body?.content?.[0]?.text || '{}';
    const parsed = extractJSON(raw) || {};

    const fullCaption = `${parsed.caption || ''} ${(parsed.hashtags || []).join(' ')}`.trim();

    // 2. Save script to generated_content
    await sbPost('generated_content', {
      business_id,
      tiktok_script:  `HOOK: ${parsed.hook || ''}\n\n${parsed.script || ''}`,
      tiktok_caption: fullCaption,
      content_theme:  parsed.content_theme || 'tiktok',
      status:         video_url ? 'published' : 'pending_approval',
      published_at:   video_url ? new Date().toISOString() : null
    });

    // 3. If video_url provided, initiate TikTok upload
    if (video_url) {
      const initResp = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        method:  'POST',
        headers: { Authorization: `Bearer ${biz.tiktok_access_token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          post_info: {
            title:           fullCaption.slice(0, 150),
            privacy_level:   'PUBLIC_TO_EVERYONE',
            disable_duet:    false,
            disable_comment: false,
            disable_stitch:  false,
          },
          source_info: { source: 'PULL_FROM_URL', video_url }
        })
      });
      const initData = await initResp.json();
      if (initData.data?.publish_id) {
        await sbPatch('businesses', `id=eq.${business_id}`, {
          next_tiktok_post_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
        });
        log('/webhook/tiktok-publish', `✅ TikTok upload initiated for ${business_id}: ${initData.data.publish_id}`);
      } else {
        log('/webhook/tiktok-publish', `TikTok upload failed: ${JSON.stringify(initData)}`);
      }
    } else {
      log('/webhook/tiktok-publish', `✅ TikTok script generated for ${business_id} — pending video upload`);
    }

  } catch (err) {
    console.error('[tiktok-publish ERROR]', err.message);
    await logError(business_id, 'tiktok-publish', err.message, req.body);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPRINT 2.1 — Unified Analytics Dashboard
// SPRINT 2.2 — Behavior-Triggered Email Flows
// ═══════════════════════════════════════════════════════════════════════════════

// ── Supabase upsert (merge-duplicates on conflict) ────────────────────────────
async function sbUpsert(table, data, onConflict) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const r   = await apiRequest('POST', url,
    { ...sbH(), 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
    data);
  if (![200, 201].includes(r.status))
    throw new Error(`sbUpsert ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

// ── sendEmailWithTags: Resend + tag support for webhook attribution ────────────
async function sendEmailWithTags(to, subject, html, tags = []) {
  const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
  const from   = clean(process.env.FROM_EMAIL)     || FROM_EMAIL;
  if (!apiKey || !to) { console.log('[REDACTED]'); return { queued: true }; }
  try {
    const payload = { from: `maroa.ai <${from}>`, to: [to], reply_to: 'hello@maroa.ai', subject, html };
    if (tags.length) payload.tags = tags;
    const r = await apiRequest('POST', 'https://api.resend.com/emails',
      { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload);
    if ([200, 201].includes(r.status)) {
      console.log('[REDACTED]');
      return { sent: true, id: r.body?.id };
    }
    return { error: r.body?.message, status: r.status };
  } catch (e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/analytics-snapshot
// Pulls today's metrics from every connected platform and upserts into
// analytics_snapshots. Each platform is isolated — one failure never blocks others.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/analytics-snapshot', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Analytics snapshot started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,facebook_page_id,meta_access_token,` +
      `linkedin_connected,linkedin_access_token,linkedin_organization_id,` +
      `twitter_connected,twitter_access_token,twitter_user_id,` +
      `tiktok_connected,tiktok_access_token`))[0];
    if (!biz) return;

    const today      = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const todayStart = `${today}T00:00:00.000Z`;
    const saved      = [];

    // ── Facebook / Meta ───────────────────────────────────────────────────────
    if (biz.facebook_page_id && biz.meta_access_token) {
      try {
        const fbR = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/insights` +
          `?metric=page_impressions,page_reach,page_engaged_users,page_fans_total` +
          `&period=day&access_token=${biz.meta_access_token}`, {});
        if (fbR.status === 200) {
          const metricMap = {};
          (fbR.body.data || []).forEach(m => {
            const v = m.values?.[m.values.length - 1]?.value || 0;
            metricMap[m.name] = typeof v === 'object'
              ? Object.values(v).reduce((a, b) => a + b, 0) : v;
          });
          const postsToday = (await sbGet('generated_content',
            `business_id=eq.${business_id}&published_at=gte.${todayStart}&select=id`)).length;
          const snap = {
            business_id, snapshot_date: today, platform: 'facebook',
            impressions:      metricMap.page_impressions     || 0,
            reach:            metricMap.page_reach           || 0,
            engagement:       metricMap.page_engaged_users   || 0,
            followers_gained: metricMap.page_fans_total      || 0,
            posts_published:  postsToday
          };
          await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
          saved.push({ platform: 'facebook', impressions: snap.impressions, reach: snap.reach, engagement: snap.engagement });
        }
      } catch (e) {
        log('/webhook/analytics-snapshot', `Facebook failed: ${e.message}`);
        await logError(business_id, 'analytics-snapshot-facebook', e.message, {});
      }
    }

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    if (biz.linkedin_connected && biz.linkedin_access_token && biz.linkedin_organization_id) {
      try {
        const orgUrn = encodeURIComponent(`urn:li:organization:${biz.linkedin_organization_id}`);
        const now    = Date.now();
        const liR    = await apiRequest('GET',
          `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity` +
          `&organizationalEntity=${orgUrn}` +
          `&timeIntervals.timeGranularityType=DAY` +
          `&timeIntervals.timeRange.start=${now - 86400000}` +
          `&timeIntervals.timeRange.end=${now}`,
          { 'Authorization': `Bearer ${biz.linkedin_access_token}`, 'LinkedIn-Version': '202401' });
        if (liR.status === 200) {
          const el   = liR.body?.elements?.[0]?.totalShareStatistics || {};
          const snap = {
            business_id, snapshot_date: today, platform: 'linkedin',
            impressions: el.impressionCount || 0,
            clicks:      el.clickCount      || 0,
            engagement:  (el.likeCount || 0) + (el.commentCount || 0) + (el.shareCount || 0)
          };
          await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
          saved.push({ platform: 'linkedin', impressions: snap.impressions, engagement: snap.engagement });
        }
      } catch (e) {
        log('/webhook/analytics-snapshot', `LinkedIn failed: ${e.message}`);
        await logError(business_id, 'analytics-snapshot-linkedin', e.message, {});
      }
    }

    // ── Twitter / X ───────────────────────────────────────────────────────────
    if (biz.twitter_connected && biz.twitter_access_token && biz.twitter_user_id) {
      try {
        const twR = await apiRequest('GET',
          `https://api.twitter.com/2/users/${biz.twitter_user_id}/tweets` +
          `?start_time=${todayStart}&tweet.fields=public_metrics&max_results=100`,
          { 'Authorization': `Bearer ${biz.twitter_access_token}` });
        if (twR.status === 200) {
          const tweets = twR.body?.data || [];
          const snap   = {
            business_id, snapshot_date: today, platform: 'twitter',
            impressions:     tweets.reduce((a, t) => a + (t.public_metrics?.impression_count || 0), 0),
            engagement:      tweets.reduce((a, t) => a + (t.public_metrics?.like_count || 0)
              + (t.public_metrics?.reply_count || 0) + (t.public_metrics?.retweet_count || 0), 0),
            clicks:          tweets.reduce((a, t) => a + (t.public_metrics?.url_link_clicks || 0), 0),
            posts_published: tweets.length
          };
          await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
          saved.push({ platform: 'twitter', impressions: snap.impressions, posts_published: snap.posts_published });
        }
      } catch (e) {
        log('/webhook/analytics-snapshot', `Twitter failed: ${e.message}`);
        await logError(business_id, 'analytics-snapshot-twitter', e.message, {});
      }
    }

    // ── TikTok ────────────────────────────────────────────────────────────────
    if (biz.tiktok_connected && biz.tiktok_access_token) {
      try {
        const ttR = await apiRequest('GET',
          `https://business-api.tiktok.com/open_api/v1.3/business/get/?business_id=${business_id}`,
          { 'Access-Token': biz.tiktok_access_token });
        if (ttR.status === 200 && ttR.body?.data) {
          const m    = ttR.body.data;
          const snap = {
            business_id, snapshot_date: today, platform: 'tiktok',
            impressions:      m.profile_views  || 0,
            followers_gained: m.follower_count || 0,
            engagement:       m.likes_count    || 0
          };
          await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
          saved.push({ platform: 'tiktok', impressions: snap.impressions });
        }
      } catch (e) {
        log('/webhook/analytics-snapshot', `TikTok failed: ${e.message}`);
        await logError(business_id, 'analytics-snapshot-tiktok', e.message, {});
      }
    }

    // ── Email stats (from retention_logs) ─────────────────────────────────────
    try {
      const emailsToday = (await sbGet('retention_logs',
        `business_id=eq.${business_id}&sent_at=gte.${todayStart}&select=id`)).length;
      if (emailsToday > 0) {
        const snap = { business_id, snapshot_date: today, platform: 'email', email_sent: emailsToday };
        await sbUpsert('analytics_snapshots', snap, 'business_id,snapshot_date,platform');
        saved.push({ platform: 'email', email_sent: emailsToday });
      }
    } catch (e) { /* silent — retention_logs may be empty */ }

    log('/webhook/analytics-snapshot', `✅ ${saved.length} snapshots saved for ${business_id}`);
  } catch (err) {
    console.error('[analytics-snapshot ERROR]', err.message);
    await logError(business_id, 'analytics-snapshot', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/analytics-report
// Aggregates last 7 days, calls Claude Opus for insights, inserts report row,
// sends formatted HTML email to business owner.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/analytics-report', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Analytics report generation started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,industry,first_name`))[0];
    if (!biz) return;

    const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const snapshots = await sbGet('analytics_snapshots',
      `business_id=eq.${business_id}&snapshot_date=gte.${weekAgo}&order=snapshot_date.desc`);

    // Aggregate across all platforms
    const totals     = { impressions: 0, reach: 0, engagement: 0, clicks: 0,
                         posts_published: 0, email_sent: 0, email_opens: 0, email_clicks: 0, followers_gained: 0 };
    const byPlatform = {};
    for (const s of snapshots) {
      for (const k of Object.keys(totals)) totals[k] += s[k] || 0;
      if (!byPlatform[s.platform]) byPlatform[s.platform] = { ...totals };
      for (const k of Object.keys(totals))
        byPlatform[s.platform][k] = (byPlatform[s.platform][k] || 0) + (s[k] || 0);
    }

    const contentThisWeek = (await sbGet('generated_content',
      `business_id=eq.${business_id}&created_at=gte.${weekAgo}T00:00:00.000Z&select=id`)).length;
    const campaigns       = await sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status`);
    const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE').length;
    const aggData = { ...totals, content_pieces_created: contentThisWeek,
                      active_campaigns: activeCampaigns, by_platform: byPlatform };

    // Claude Opus — generate structured report
    const makePrompt = (strict = false) => strict
      ? `Return a raw JSON object ONLY — no text, no markdown fences. Required keys: headline (string), wins (array of 3 strings with real numbers from the data), concerns (array of 1-2 strings), recommendations (array of 3 actionable strings), overall_score (integer 1-10). Business: ${biz.business_name} (${biz.industry}). Data: ${JSON.stringify(aggData)}`
      : `You are a marketing analyst writing a weekly report. Return ONLY valid JSON, no markdown, no explanation.

Write a weekly performance report for ${biz.business_name} (${biz.industry}).

This week's data:
${JSON.stringify(aggData, null, 2)}

Return exactly this JSON structure:
{
  "headline": "one sentence summary of the week",
  "wins": ["specific win with real numbers 1", "specific win with real numbers 2", "specific win with real numbers 3"],
  "concerns": ["thing to watch 1"],
  "recommendations": ["specific action for next week 1", "specific action 2", "specific action 3"],
  "overall_score": 7
}`;

    let report = await callClaude(makePrompt(false), 'monthly_review', 1000);
    if (report._raw) report = await callClaude(makePrompt(true), 'monthly_review', 800);

    const dbReport = await sbPost('analytics_reports', {
      business_id,
      week_start:      weekAgo,
      headline:        report.headline        || 'Weekly marketing performance complete',
      wins:            report.wins            || [],
      concerns:        report.concerns        || [],
      recommendations: report.recommendations || [],
      overall_score:   report.overall_score   || null,
      raw_data:        aggData
    });

    // HTML email
    const scoreColor  = (report.overall_score || 5) >= 7 ? '#22c55e'
                      : (report.overall_score || 5) >= 4 ? '#f59e0b' : '#ef4444';
    const emailHtml = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <h2 style="color:#667eea;margin-bottom:4px">📊 Weekly Marketing Report</h2>
  <p style="color:#64748b;margin-top:0">${biz.business_name}</p>
  <p style="font-size:17px;font-weight:500;border-left:4px solid #667eea;padding-left:12px">${report.headline || ''}</p>
  <div style="background:#f8fafc;border-radius:12px;padding:24px;margin:20px 0;text-align:center">
    <div style="font-size:64px;font-weight:bold;color:${scoreColor};line-height:1">${report.overall_score ?? '—'}</div>
    <div style="font-size:18px;color:#94a3b8;margin-top:4px">/ 10 overall score</div>
  </div>
  <h3 style="color:#22c55e">🏆 This Week's Wins</h3>
  <ul style="line-height:2">${(report.wins || []).map(w => `<li>${w}</li>`).join('')}</ul>
  <h3 style="color:#f59e0b">⚠️ Things to Watch</h3>
  <ul style="line-height:2">${(report.concerns || []).map(c => `<li>${c}</li>`).join('')}</ul>
  <h3 style="color:#667eea">🎯 Actions for Next Week</h3>
  <ul style="line-height:2">${(report.recommendations || []).map(r => `<li>${r}</li>`).join('')}</ul>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="color:#94a3b8;font-size:13px">
    Impressions: ${totals.impressions.toLocaleString()} &nbsp;·&nbsp;
    Reach: ${totals.reach.toLocaleString()} &nbsp;·&nbsp;
    Engagement: ${totals.engagement.toLocaleString()} &nbsp;·&nbsp;
    Posts: ${totals.posts_published} &nbsp;·&nbsp;
    Active Campaigns: ${activeCampaigns}
  </p>
  <a href="https://maroa-ai-marketing-automator.vercel.app/analytics"
     style="display:inline-block;background:#667eea;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:8px">
    View Full Analytics →
  </a>
</div>`;

    await sendEmail(biz.email, `Your weekly marketing report — ${biz.business_name}`, emailHtml);
    log('/webhook/analytics-report', `✅ Report ${dbReport?.id} created — score: ${report.overall_score}`);

  } catch (err) {
    console.error('[analytics-report ERROR]', err.message);
    await logError(business_id, 'analytics-report', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/analytics-get?business_id=X
// Returns last 30 days of snapshots + latest report + aggregate totals.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/analytics-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const [snapshots, reports] = await Promise.all([
      sbGet('analytics_snapshots',
        `business_id=eq.${business_id}&snapshot_date=gte.${thirtyDaysAgo}&order=snapshot_date.asc`),
      sbGet('analytics_reports',
        `business_id=eq.${business_id}&order=created_at.desc&limit=1`)
    ]);
    const totals = snapshots.reduce((acc, s) => {
      acc.impressions     += s.impressions     || 0;
      acc.reach           += s.reach           || 0;
      acc.engagement      += s.engagement      || 0;
      acc.posts_published += s.posts_published || 0;
      return acc;
    }, { impressions: 0, reach: 0, engagement: 0, posts_published: 0 });
    res.json({ snapshots, latest_report: reports[0] || null, totals, days: 30 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/email-sequence-create
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/email-sequence-create', async (req, res) => {
  const { business_id, name, trigger_type, trigger_value, delay_hours = 0, emails = [] } = req.body;
  const VALID_TRIGGERS = ['signup', 'no_open_7d', 'link_click', 'purchase', 'cart_abandon'];
  if (!business_id)
    return res.status(400).json({ error: 'business_id required' });
  if (!name)
    return res.status(400).json({ error: 'name required' });
  if (!VALID_TRIGGERS.includes(trigger_type))
    return res.status(400).json({ error: `trigger_type must be one of: ${VALID_TRIGGERS.join(', ')}` });
  if (!Array.isArray(emails) || !emails.length)
    return res.status(400).json({ error: 'emails array required (min 1 item)' });
  try {
    const seq = await sbPost('email_sequences', {
      business_id, name, trigger_type, trigger_value: trigger_value || null,
      delay_hours, is_active: true, emails
    });
    res.json({ sequence_id: seq.id, name: seq.name, trigger_type: seq.trigger_type, email_count: emails.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/email-enroll
// Enrolls a contact into the first active sequence matching trigger_type.
// Deduplication: silently skips if already active in the same sequence.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/email-enroll', async (req, res) => {
  const { business_id, contact_email, contact_name, trigger_type, sequence_id } = req.body;
  if (!business_id || !contact_email)
    return res.status(400).json({ error: 'business_id and contact_email required' });
  res.json({ received: true, message: 'Enrollment processing' });

  try {
    let seq;
    if (sequence_id) {
      seq = (await sbGet('email_sequences', `id=eq.${sequence_id}&is_active=eq.true`))[0];
    } else if (trigger_type) {
      seq = (await sbGet('email_sequences',
        `business_id=eq.${business_id}&trigger_type=eq.${trigger_type}&is_active=eq.true&limit=1`))[0];
    }
    if (!seq) {
      return log('/webhook/email-enroll', `No active sequence for trigger=${trigger_type} biz=${business_id}`);
    }

    // Deduplicate
    const existing = await sbGet('contact_enrollments',
      `contact_email=eq.${encodeURIComponent(contact_email)}&sequence_id=eq.${seq.id}&status=eq.active`);
    if (existing.length) {
      return log('/webhook/email-enroll', `Already enrolled: ${contact_email} → seq ${seq.id}`);
    }

    // Respect step-0 delay_hours (can be overridden per-step)
    const firstDelay = seq.emails?.[0]?.delay_hours ?? seq.delay_hours ?? 0;
    const nextSendAt = new Date(Date.now() + firstDelay * 3600000).toISOString();

    await sbPost('contact_enrollments', {
      business_id, contact_email, contact_name: contact_name || null,
      sequence_id: seq.id, current_step: 0, status: 'active', next_send_at: nextSendAt
    });
    log('/webhook/email-enroll', `✅ Enrolled ${contact_email} into "${seq.name}" (next: ${nextSendAt})`);
  } catch (err) {
    console.error('[email-enroll ERROR]', err.message);
    await logError(business_id, 'email-enroll', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/email-trigger  — Resend webhook receiver
// Must respond 200 immediately. Handles open / click / bounce events.
// Register this URL in Resend Dashboard → Webhooks.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/email-trigger', async (req, res) => {
  res.json({ received: true }); // Resend requires fast 200

  try {
    const { type, data = {} } = req.body;
    const contact_email = Array.isArray(data.to) ? data.to[0] : (data.email_address || '');
    const tags          = data.tags || {};
    const business_id   = tags.business_id || null;
    if (!contact_email) return;

    // Bounce — mark all active enrollments for this address
    if (type === 'email.bounced') {
      await sbPatch('contact_enrollments',
        `contact_email=eq.${encodeURIComponent(contact_email)}&status=eq.active`,
        { status: 'bounced' });
      return log('/webhook/email-trigger', `Bounce recorded: ${contact_email}`);
    }

    // Open — log to retention_logs for re-engagement tracking
    if (type === 'email.opened' && business_id) {
      try {
        await sbPost('retention_logs', {
          business_id,
          email_type: 'email_opened',
          subject:    data.subject || 'email opened',
          sent_at:    new Date().toISOString()
        });
      } catch { /* retention_logs schema may vary */ }
      return log('/webhook/email-trigger', `Open recorded: ${contact_email}`);
    }

    // Click — auto-enroll into link_click sequence if one exists
    if (type === 'email.clicked' && business_id) {
      const seqs = await sbGet('email_sequences',
        `business_id=eq.${business_id}&trigger_type=eq.link_click&is_active=eq.true&limit=1`);
      if (!seqs.length) return;
      const already = await sbGet('contact_enrollments',
        `contact_email=eq.${encodeURIComponent(contact_email)}&sequence_id=eq.${seqs[0].id}&status=eq.active`);
      if (!already.length) {
        await sbPost('contact_enrollments', {
          business_id, contact_email, sequence_id: seqs[0].id,
          current_step: 0, status: 'active', next_send_at: new Date().toISOString()
        });
        log('/webhook/email-trigger', `Click-enrolled ${contact_email} → link_click sequence`);
      }
    }
  } catch (err) {
    console.error('[email-trigger ERROR]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/email-sequence-process
// Processes ALL due enrollments across all businesses (up to 50 per run).
// Called by WF36 every 30 minutes. No request body needed.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/email-sequence-process', async (req, res) => {
  res.json({ received: true, message: 'Processing email sequences' });

  let processed = 0, sent = 0, completed = 0;
  try {
    const now = new Date().toISOString();
    const due = await sbGet('contact_enrollments',
      `next_send_at=lte.${now}&status=eq.active&select=*&limit=50`);

    for (const enrollment of due) {
      try {
        processed++;

        // Fetch sequence and validate step
        const seq = (await sbGet('email_sequences', `id=eq.${enrollment.sequence_id}`))[0];
        if (!seq?.emails?.[enrollment.current_step]) {
          await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`,
            { status: 'completed', completed_at: now });
          completed++;
          continue;
        }

        const step = seq.emails[enrollment.current_step];
        const biz  = (await sbGet('businesses',
          `id=eq.${enrollment.business_id}&select=business_name,brand_tone,industry`))[0];
        if (!biz) continue;

        const contactName = enrollment.contact_name || enrollment.contact_email.split('@')[0];
        const prompt =
`Write a marketing email for ${contactName} from ${biz.business_name}.
Tone: ${biz.brand_tone || 'professional and friendly'}
Subject goal: ${step.subject_prompt || 'Engaging marketing subject'}
Body goal: ${step.body_prompt || 'Valuable content with one clear CTA'}
Max 200 words. Conversational, personal, one clear action at the end.
Return ONLY valid JSON: {"subject":"...","body_html":"..."}`;

        const email = await callClaude(prompt, 'social_post', 600);
        if (!email.subject || !email.body_html) {
          log('/webhook/email-sequence-process', `Claude parse fail — enrollment ${enrollment.id}`);
          continue;
        }

        await sendEmailWithTags(
          enrollment.contact_email,
          email.subject,
          email.body_html,
          [
            { name: 'business_id', value: enrollment.business_id },
            { name: 'sequence_id', value: enrollment.sequence_id },
            { name: 'step',        value: String(enrollment.current_step) }
          ]
        );
        sent++;

        const isLast = enrollment.current_step + 1 >= seq.emails.length;
        if (isLast) {
          await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`,
            { status: 'completed', completed_at: now });
          completed++;
        } else {
          const nextStep   = seq.emails[enrollment.current_step + 1];
          const delayHours = nextStep.delay_hours ?? 24;
          await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`, {
            current_step: enrollment.current_step + 1,
            next_send_at: new Date(Date.now() + delayHours * 3600000).toISOString()
          });
        }
      } catch (stepErr) {
        console.error(`[email-sequence-process] step error ${enrollment.id}:`, stepErr.message);
        await logError(enrollment.business_id, 'email-sequence-process',
          stepErr.message, { enrollment_id: enrollment.id });
      }
    }
    log('/webhook/email-sequence-process',
      `✅ processed=${processed} sent=${sent} completed=${completed}`);
  } catch (err) {
    console.error('[email-sequence-process ERROR]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/no-open-candidates?days=7
// Returns businesses with old retention_log entries whose email is NOT
// already actively enrolled. Used by WF37.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/no-open-candidates', async (req, res) => {
  const days   = parseInt(req.query.days || '7', 10);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  try {
    // Step 1: get all business_ids with retention logs older than cutoff
    const oldLogs = await sbGet('retention_logs', `sent_at=lt.${cutoff}&select=business_id`);
    const bizIds  = [...new Set(oldLogs.map(r => r.business_id).filter(Boolean))];
    if (!bizIds.length) return res.json({ candidates: [], count: 0 });

    // Step 2: fetch those businesses
    const businesses = await sbGet('businesses',
      `id=in.(${bizIds.join(',')})&is_active=eq.true&select=id,email,first_name,business_name`);
    const emails = businesses.map(b => b.email).filter(Boolean);
    if (!emails.length) return res.json({ candidates: [], count: 0 });

    // Step 3: find which emails are already actively enrolled
    const active = await sbGet('contact_enrollments',
      `contact_email=in.(${emails.map(e => encodeURIComponent(e)).join(',')})&status=eq.active&select=contact_email`);
    const enrolledSet = new Set(active.map(e => e.contact_email));

    // Step 4: return those NOT enrolled
    const candidates = businesses
      .filter(b => b.email && !enrolledSet.has(b.email))
      .map(b => ({
        business_id:   b.id,
        contact_email: b.email,
        contact_name:  b.first_name || b.business_name
      }));

    res.json({ candidates, count: candidates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPRINT 3 — Paid Ads Module (Meta + Google)
// ═══════════════════════════════════════════════════════════════════════════════

const GOOGLE_ADS_DEV_TOKEN    = clean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN) || '';
const GOOGLE_ADS_CLIENT_ID    = clean(process.env.GOOGLE_ADS_CLIENT_ID)       || '';
const GOOGLE_ADS_CLIENT_SECRET= clean(process.env.GOOGLE_ADS_CLIENT_SECRET)   || '';

// ── Google Ads REST helper ─────────────────────────────────────────────────────
async function googleAdsReq(method, path, accessToken, body = null) {
  return apiRequest(method,
    `https://googleads.googleapis.com/v17/${path}`,
    {
      'Authorization':   `Bearer ${accessToken}`,
      'developer-token': GOOGLE_ADS_DEV_TOKEN,
      'Content-Type':    'application/json'
    },
    body
  );
}

// Strip dashes from Google Ads customer ID (123-456-7890 → 1234567890)
function gCid(raw) { return (raw || '').replace(/-/g, ''); }

// ── Meta ad_account_id normaliser (ensure act_ prefix) ───────────────────────
function actId(raw) { return (raw || '').startsWith('act_') ? raw : `act_${raw}`; }

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/meta-campaign-create
// Generates AI strategy, creates 3 image creatives, builds full Meta campaign
// (campaign → ad set → ad creatives → ads), all in PAUSED state for review.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/meta-campaign-create', async (req, res) => {
  const { business_id, objective = 'OUTCOME_TRAFFIC', monthly_budget = 300 } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,first_name,industry,target_audience,` +
      `location,brand_tone,marketing_goal,competitors,meta_access_token,ad_account_id,` +
      `facebook_page_id,target_cpc,avg_order_value`))[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const draftMode = !biz.meta_access_token || !biz.ad_account_id;
    if (draftMode) {
      // DRAFT MODE — build strategy + creatives without Meta API
      res.json({ received: true, status: 'draft', message: 'Campaign strategy being built in draft mode — connect Meta Ads to launch' });

      setImmediate(async () => {
        try {
          const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));
          const strategyPrompt =
`You are a Meta Ads expert. Create a campaign strategy for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'grow'} | Budget: $${monthly_budget}/mo | Audience: ${biz.target_audience || 'general'}
Location: ${biz.location || 'United States'} | Tone: ${biz.brand_tone || 'professional'}
Return ONLY valid JSON: { "objective": "OUTCOME_TRAFFIC", "daily_budget_usd": ${dailyBudget}, "targeting": { "age_min": 25, "age_max": 55 }, "creatives": [{ "headline": "max 40 chars", "primary_text": "max 125 chars", "description": "max 30 chars", "cta": "LEARN_MORE", "image_prompt": "image description" }] }`;
          const strategy = await callClaude(strategyPrompt, 'strategy', 1500);
          const creatives = Array.isArray(strategy.creatives) ? strategy.creatives.slice(0, 3) : [];

          // Save draft campaign
          await sbPost('ad_campaigns', {
            business_id, platform: 'meta', status: 'draft',
            daily_budget: dailyBudget, objective: strategy.objective || objective,
            ai_strategy: JSON.stringify(strategy), last_decision: 'Draft — awaiting Meta Ads connection',
            last_decision_reason: 'Campaign ready to launch when ad account connected',
            business_name: biz.business_name
          });

          // Save draft creatives
          for (const cr of creatives) {
            await sbPost('ad_creatives', {
              business_id, platform: 'meta', headline: cr.headline,
              primary_text: cr.primary_text, description: cr.description,
              cta: cr.cta, image_prompt: cr.image_prompt, status: 'draft'
            }).catch(() => {});
          }

          if (biz.email) {
            await sendEmail(biz.email, `Your ad campaign strategy is ready — ${biz.business_name}`,
              `<h2>Your AI Ad Campaign is Ready (Draft)</h2><p>Your AI built a complete ad strategy with ${creatives.length} creative variations.</p><p><strong>To launch:</strong> Connect your Meta Ads account in Settings.</p><p><a href="https://maroa-ai-marketing-automator.vercel.app/settings" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Connect Meta Ads →</a></p>`
            ).catch(() => {});
          }
          log('/webhook/meta-campaign-create', `✅ Draft campaign saved for ${biz.business_name}`);
        } catch (err) {
          console.error('[meta-campaign-create DRAFT ERROR]', err.message);
          await logError(business_id, 'meta-campaign-create-draft', err.message).catch(() => {});
        }
      });
      return; // exit — draft mode handled
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ received: true, message: 'Meta campaign creation started — check your email in ~2 minutes' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,first_name,industry,target_audience,` +
      `location,brand_tone,marketing_goal,competitors,meta_access_token,ad_account_id,` +
      `facebook_page_id,target_cpc,avg_order_value`))[0];
    const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));
    const accountId   = actId(biz.ad_account_id);
    const token       = biz.meta_access_token;

    // 1. Claude Opus — full campaign strategy + 3 creative variations
    const strategyPrompt =
`You are a Meta Ads expert. Return ONLY valid JSON, no markdown, no explanation.

Create a complete Meta Ads campaign strategy for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'grow brand awareness and leads'}
Monthly budget: $${monthly_budget}
Target audience: ${biz.target_audience || 'general consumers'}
Location: ${biz.location || 'United States'}
Competitors: ${biz.competitors ? JSON.stringify(biz.competitors).slice(0, 200) : 'not specified'}
Brand tone: ${biz.brand_tone || 'professional and friendly'}

Return exactly this JSON:
{
  "objective": "${objective}",
  "daily_budget_usd": ${dailyBudget},
  "targeting": {
    "age_min": 25,
    "age_max": 55,
    "genders": [1, 2],
    "geo_locations": { "countries": ["US"] }
  },
  "creatives": [
    {
      "headline": "max 40 chars — hook variation 1",
      "primary_text": "max 125 chars — value prop 1",
      "description": "max 30 chars",
      "cta": "LEARN_MORE",
      "image_prompt": "detailed description of ideal image for this ad"
    },
    {
      "headline": "max 40 chars — angle variation 2",
      "primary_text": "max 125 chars — social proof angle",
      "description": "max 30 chars",
      "cta": "SIGN_UP",
      "image_prompt": "detailed description of second image"
    },
    {
      "headline": "max 40 chars — urgency variation 3",
      "primary_text": "max 125 chars — urgency or offer angle",
      "description": "max 30 chars",
      "cta": "LEARN_MORE",
      "image_prompt": "detailed description of third image"
    }
  ]
}`;

    const strategy   = await callClaude(strategyPrompt, 'strategy', 1500);
    const rawCreatives = Array.isArray(strategy.creatives) ? strategy.creatives.slice(0, 3) : [];
    const targeting    = strategy.targeting || { age_min: 25, age_max: 55, genders: [1, 2], geo_locations: { countries: ['US'] } };
    const campaignObj  = strategy.objective || objective;
    const campBudget   = strategy.daily_budget_usd || dailyBudget;

    // 2. Generate images via Flux / Pexels fallback → save to Supabase Storage
    const creativesWithImages = [];
    for (const cr of rawCreatives) {
      try {
        const img = await generateImage(
          cr.image_prompt || `${biz.industry} advertisement ${biz.business_name}`,
          `${biz.industry} marketing professional advertisement`
        );
        const permanentUrl = img.url ? await saveImageToSupabase(img.url, business_id) : null;
        creativesWithImages.push({ ...cr, image_url: permanentUrl, image_source: img.source });
      } catch { creativesWithImages.push({ ...cr, image_url: null, image_source: 'none' }); }
    }

    // 3. Create Meta Campaign
    const campaignName = `${biz.business_name} — ${campaignObj} — ${new Date().toISOString().slice(0, 10)}`;
    const campResp = await apiRequest('POST',
      `https://graph.facebook.com/v19.0/${accountId}/campaigns`,
      { 'Content-Type': 'application/json' },
      { name: campaignName, objective: campaignObj, status: 'PAUSED',
        special_ad_categories: [], access_token: token });

    if (!campResp.body?.id)
      throw new Error(`Campaign create failed: ${JSON.stringify(campResp.body).slice(0, 300)}`);
    const metaCampaignId = campResp.body.id;

    // 4. Create Ad Set
    const adSetResp = await apiRequest('POST',
      `https://graph.facebook.com/v19.0/${accountId}/adsets`,
      { 'Content-Type': 'application/json' },
      {
        name:              `${biz.business_name} — AdSet — ${new Date().toISOString().slice(0, 10)}`,
        campaign_id:       metaCampaignId,
        daily_budget:      Math.round(campBudget * 100),
        billing_event:     'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        targeting:         JSON.stringify(targeting),
        status:            'PAUSED',
        access_token:      token
      });

    if (!adSetResp.body?.id)
      throw new Error(`Ad set create failed: ${JSON.stringify(adSetResp.body).slice(0, 300)}`);
    const metaAdSetId = adSetResp.body.id;

    // 5. Save DB record early (so creatives can reference campaign_id)
    const campaignRow = await sbPost('ad_campaigns', {
      business_id,
      platform:         'meta',
      meta_campaign_id: metaCampaignId,
      meta_ad_set_id:   metaAdSetId,
      meta_access_token: token,
      facebook_page_id: biz.facebook_page_id,
      status:           'paused',
      daily_budget:     campBudget,
      objective:        campaignObj,
      ai_strategy:      strategy,
      creatives:        creativesWithImages.map(c => ({ headline: c.headline, image_url: c.image_url }))
    });

    // 6. Create ads (one per creative)
    const adsCreated = [];
    for (let i = 0; i < creativesWithImages.length; i++) {
      const cr = creativesWithImages[i];
      try {
        // Upload image
        let imageHash = null;
        if (cr.image_url) {
          try {
            const imgUp = await apiRequest('POST',
              `https://graph.facebook.com/v19.0/${accountId}/adimages`,
              { 'Content-Type': 'application/json' },
              { url: cr.image_url, access_token: token });
            const imgs = imgUp.body?.images;
            if (imgs) imageHash = imgs[Object.keys(imgs)[0]]?.hash;
          } catch { /* non-critical */ }
        }

        // Build link_data
        const linkData = {
          message:     cr.primary_text  || '',
          link:        `https://www.facebook.com/${biz.facebook_page_id || ''}`,
          name:        (cr.headline     || '').slice(0, 40),
          description: (cr.description  || '').slice(0, 30),
          call_to_action: { type: cr.cta || 'LEARN_MORE' }
        };
        if (imageHash) linkData.image_hash = imageHash;

        // Create Ad Creative
        const creativeResp = await apiRequest('POST',
          `https://graph.facebook.com/v19.0/${accountId}/adcreatives`,
          { 'Content-Type': 'application/json' },
          {
            name:               `${biz.business_name} Creative ${i + 1}`,
            object_story_spec:  JSON.stringify({ page_id: biz.facebook_page_id, link_data: linkData }),
            access_token:       token
          });
        const metaCreativeId = creativeResp.body?.id;

        // Create Ad
        if (metaCreativeId) {
          const adResp = await apiRequest('POST',
            `https://graph.facebook.com/v19.0/${accountId}/ads`,
            { 'Content-Type': 'application/json' },
            {
              name:         `${biz.business_name} Ad ${i + 1}`,
              adset_id:     metaAdSetId,
              creative:     JSON.stringify({ creative_id: metaCreativeId }),
              status:       'PAUSED',
              access_token: token
            });
          if (adResp.body?.id) adsCreated.push({ ad_id: adResp.body.id, creative_id: metaCreativeId });
        }

        // Save to ad_creatives
        await sbPost('ad_creatives', {
          business_id,
          campaign_id:      campaignRow?.id || null,
          platform:         'meta',
          headline:         cr.headline,
          primary_text:     cr.primary_text,
          description:      cr.description,
          cta:              cr.cta,
          image_url:        cr.image_url,
          image_prompt:     cr.image_prompt,
          meta_creative_id: metaCreativeId || null,
          status:           'active'
        });
      } catch (ce) {
        log('/webhook/meta-campaign-create', `Creative ${i + 1} error: ${ce.message}`);
      }
    }

    // 7. Review email
    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <h2 style="color:#667eea">🎯 Your Meta Ad Campaign is Ready for Review</h2>
  <p>Hi ${biz.first_name || biz.business_name},</p>
  <p>Your AI built a complete Meta Ads campaign for <strong>${biz.business_name}</strong> with <strong>${adsCreated.length} ad variations</strong>, each with a unique image, headline and angle.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Campaign</td><td style="padding:8px 12px">${campaignName}</td></tr>
    <tr><td style="padding:8px 12px;font-weight:600">Objective</td><td style="padding:8px 12px">${campaignObj}</td></tr>
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Daily Budget</td><td style="padding:8px 12px">$${campBudget}</td></tr>
    <tr><td style="padding:8px 12px;font-weight:600">Ad Variations</td><td style="padding:8px 12px">${adsCreated.length} creatives</td></tr>
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Status</td><td style="padding:8px 12px">⏸️ Paused — awaiting your review</td></tr>
  </table>
  <p>Review in Meta Ads Manager, then activate when you're ready.</p>
  <a href="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${biz.ad_account_id}"
     style="display:inline-block;background:#667eea;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:8px">
    Review in Ads Manager →
  </a>
</div>`;
    await sendEmail(biz.email, `Your Meta ad campaign is ready for review — ${biz.business_name}`, html);
    try { storeInsight(business_id, 'meta_ads', 'ad_strategy', 'ad_angle', `${campaignObj}: ${rawCreatives[0]?.headline || ''}`); storeInsight(business_id, 'meta_ads', 'ad_strategy', 'ads_created', `${adsCreated.length} ads, budget $${campBudget}/day`); } catch {}
    log('/webhook/meta-campaign-create', `✅ Meta campaign ${metaCampaignId} — ${adsCreated.length} ads created`);

  } catch (err) {
    console.error('[meta-campaign-create ERROR]', err.message);
    await logError(business_id, 'meta-campaign-create', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/meta-campaign-activate
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/meta-campaign-activate', planGate('paid_ads'), async (req, res) => {
  const { business_id, campaign_id } = req.body;
  if (!business_id || !campaign_id)
    return res.status(400).json({ error: 'business_id and campaign_id required' });
  try {
    const campaign = (await sbGet('ad_campaigns', `id=eq.${campaign_id}&business_id=eq.${business_id}`))[0];
    if (!campaign)     return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.platform !== 'meta') return res.status(400).json({ error: 'Not a Meta campaign — use /webhook/google-campaign-activate' });

    const token = campaign.meta_access_token;

    // Activate campaign + ad set via Meta API
    await apiRequest('POST', `https://graph.facebook.com/v19.0/${campaign.meta_campaign_id}`,
      { 'Content-Type': 'application/json' }, { status: 'ACTIVE', access_token: token });

    if (campaign.meta_ad_set_id) {
      await apiRequest('POST', `https://graph.facebook.com/v19.0/${campaign.meta_ad_set_id}`,
        { 'Content-Type': 'application/json' }, { status: 'ACTIVE', access_token: token });
    }

    // Activate all ads for this campaign (stored in ad_creatives)
    const creativeRows = await sbGet('ad_creatives',
      `campaign_id=eq.${campaign_id}&platform=eq.meta&select=meta_creative_id`);
    // Note: we stored creative IDs; actual ad IDs would be in creatives JSONB
    const adsData = Array.isArray(campaign.creatives) ? campaign.creatives : [];
    for (const adEntry of adsData) {
      if (adEntry.ad_id) {
        try {
          await apiRequest('POST', `https://graph.facebook.com/v19.0/${adEntry.ad_id}`,
            { 'Content-Type': 'application/json' }, { status: 'ACTIVE', access_token: token });
        } catch { /* individual ad activate failure is non-critical */ }
      }
    }

    await sbPatch('ad_campaigns', `id=eq.${campaign_id}`, { status: 'active' });
    res.json({ activated: true, campaign_id, meta_campaign_id: campaign.meta_campaign_id });
  } catch (err) {
    console.error('[meta-campaign-activate ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/meta-campaign-optimize  — LEVEL 7: PORTFOLIO OPTIMIZER
// Full portfolio optimization — pulls all campaigns, Claude Opus decides
// budget reallocation across the entire portfolio at once.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/meta-campaign-optimize', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Portfolio optimization started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,marketing_goal,target_cpc,avg_order_value`))[0];
    if (!biz) return;

    const campaigns = await sbGet('ad_campaigns',
      `business_id=eq.${business_id}&platform=eq.meta&status=eq.active`);

    if (!campaigns.length) return log('/webhook/meta-campaign-optimize', 'No active campaigns');

    // Pull 7-day insights for ALL campaigns
    const campData = [];
    for (const camp of campaigns) {
      try {
        const insR = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}/insights` +
          `?fields=impressions,clicks,spend,actions,cpc,ctr,frequency` +
          `&date_preset=last_7d&access_token=${camp.meta_access_token}`, {});
        const d = insR.status === 200 ? (insR.body?.data?.[0] || {}) : {};
        const impressions = parseInt(d.impressions || 0);
        const clicks      = parseInt(d.clicks || 0);
        const spend       = parseFloat(d.spend || 0);
        const ctr         = parseFloat(d.ctr || 0);
        const frequency   = parseFloat(d.frequency || 0);
        const conversions = (d.actions || []).filter(a => a.action_type === 'purchase' || a.action_type === 'lead').reduce((s, a) => s + parseInt(a.value || 0), 0);
        const revenue     = conversions * (biz.avg_order_value || 50);
        const roas        = spend > 0 ? revenue / spend : 0;
        campData.push({ id: camp.id, meta_id: camp.meta_campaign_id, meta_ad_set_id: camp.meta_ad_set_id, token: camp.meta_access_token, name: camp.last_decision_reason || camp.campaign_type || 'campaign', daily_budget: camp.daily_budget || 10, impressions, clicks, spend, ctr, frequency, conversions, roas });
      } catch {}
    }

    const totalSpend   = campData.reduce((s,c) => s + c.spend, 0);
    const totalRevenue = campData.reduce((s,c) => s + c.conversions * (biz.avg_order_value || 50), 0);
    const portfolioRoas = totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : '0';

    // Claude Opus — full portfolio optimization decision
    const prompt =
`You are a senior media buyer optimizing a full ad portfolio for ${biz.business_name}.
Goal: ${biz.marketing_goal || 'maximize leads'}

PORTFOLIO SUMMARY:
Total spend (7d): $${totalSpend.toFixed(2)} | Total revenue: $${totalRevenue.toFixed(2)} | Portfolio ROAS: ${portfolioRoas}x

INDIVIDUAL CAMPAIGNS:
${campData.map(c => `- ${c.name}: budget=$${c.daily_budget}/day spend=$${c.spend.toFixed(2)} impressions=${c.impressions} clicks=${c.clicks} CTR=${c.ctr.toFixed(2)}% ROAS=${c.roas.toFixed(2)}x frequency=${c.frequency.toFixed(1)} conversions=${c.conversions}`).join('\n')}

OPTIMIZE the budget allocation across ALL campaigns as a portfolio.
Rules:
- Move money FROM underperformers TO overperformers
- Never pause a campaign trending UP (increasing CTR/clicks) even if ROAS is currently low
- Never boost a campaign with DECLINING CTR even if ROAS looks ok (creative fatigue)
- Consider audience saturation: frequency > 2.5 means oversaturation
- Total daily budget must stay the same (redistribute, don't increase total)

Return ONLY valid JSON:
{
  "portfolio_roas": ${portfolioRoas},
  "reallocations": [
    {"campaign_id": "id", "current_budget": N, "new_budget": N, "action": "increase|decrease|pause|keep", "reason": "string"}
  ],
  "portfolio_health": "healthy|needs_attention|critical",
  "summary": "1-2 sentence summary"
}`;

    const result = await callClaude(prompt, 'strategy', 1200);
    const reallocations = result.reallocations || [];

    // Execute reallocations
    for (const r of reallocations) {
      const camp = campData.find(c => c.id === r.campaign_id);
      if (!camp) continue;
      try {
        if ((r.action === 'increase' || r.action === 'decrease') && camp.meta_ad_set_id && r.new_budget > 0) {
          await apiRequest('POST', `https://graph.facebook.com/v19.0/${camp.meta_ad_set_id}`,
            { 'Content-Type': 'application/json' },
            { daily_budget: Math.round(r.new_budget * 100), access_token: camp.token });
          await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { daily_budget: r.new_budget, last_decision: `Portfolio ${r.action}: $${camp.daily_budget}→$${r.new_budget}`, last_decision_reason: r.reason, last_optimized_at: new Date().toISOString() });
        } else if (r.action === 'pause') {
          await apiRequest('POST', `https://graph.facebook.com/v19.0/${camp.meta_id}`,
            { 'Content-Type': 'application/json' },
            { status: 'PAUSED', access_token: camp.token });
          await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { status: 'paused', paused_reason: r.reason, last_optimized_at: new Date().toISOString() });
        }
      } catch (e) { log('/webhook/meta-campaign-optimize', `Reallocation error ${camp.id}: ${e.message}`); }
    }

    // Log to ad_performance_logs
    try {
      await sbPost('ad_performance_logs', {
        business_id, recommendation: result.summary || '', reason: JSON.stringify(reallocations),
        spend: totalSpend, roas: parseFloat(portfolioRoas), logged_at: new Date().toISOString()
      });
    } catch {}

    try { storeInsight(business_id, 'meta_ads', 'ad_strategy', 'portfolio_health', result.portfolio_health || ''); storeInsight(business_id, 'meta_ads', 'ad_strategy', 'optimization_summary', result.summary || ''); } catch {}
    log('/webhook/meta-campaign-optimize', `✅ Portfolio optimized: ${result.summary || ''}`);
  } catch (err) {
    console.error('[meta-campaign-optimize ERROR]', err.message);
    await logError(business_id, 'meta-campaign-optimize', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/meta-campaigns-get?business_id=X
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/meta-campaigns-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const [campaigns, creatives] = await Promise.all([
      sbGet('ad_campaigns', `business_id=eq.${business_id}&platform=eq.meta&order=created_at.desc`),
      sbGet('ad_creatives', `business_id=eq.${business_id}&platform=eq.meta&order=created_at.desc`)
    ]);
    const summary = {
      total:       campaigns.length,
      active:      campaigns.filter(c => c.status === 'active').length,
      paused:      campaigns.filter(c => c.status === 'paused').length,
      total_spend: campaigns.reduce((a, c) => a + parseFloat(c.total_spend || 0), 0).toFixed(2),
      avg_roas:    campaigns.length
        ? (campaigns.reduce((a, c) => a + parseFloat(c.roas || 0), 0) / campaigns.length).toFixed(2)
        : '0.00'
    };
    res.json({ campaigns, creatives, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/google-campaign-create
// Generates AI keyword/ad strategy, creates Search campaign via Google Ads API.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/google-campaign-create', async (req, res) => {
  const { business_id, monthly_budget = 200 } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,first_name,industry,target_audience,` +
      `location,brand_tone,marketing_goal,google_ads_customer_id,google_access_token`))[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });
    if (!biz.google_ads_customer_id)
      return res.status(400).json({ error: 'google_ads_not_connected', detail: 'No google_ads_customer_id — connect Google Ads in Settings' });
    if (!biz.google_access_token)
      return res.status(400).json({ error: 'google_ads_not_connected', detail: 'No google_access_token' });
    if (!GOOGLE_ADS_DEV_TOKEN)
      return res.status(400).json({ error: 'google_ads_not_configured', detail: 'GOOGLE_ADS_DEVELOPER_TOKEN not set on server' });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  res.json({ received: true, message: 'Google Ads campaign creation started — check email in ~2 minutes' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,email,first_name,industry,target_audience,` +
      `location,brand_tone,marketing_goal,google_ads_customer_id,google_access_token`))[0];

    const customerId  = gCid(biz.google_ads_customer_id);
    const token       = biz.google_access_token;
    const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));

    // 1. Claude Opus — Google Search strategy
    const stratPrompt =
`You are a Google Ads expert. Return ONLY valid JSON, no markdown.

Create a Google Search Ads campaign for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'generate leads'} | Budget: $${monthly_budget}/month | Location: ${biz.location || 'United States'}
Target audience: ${biz.target_audience || 'general consumers'} | Tone: ${biz.brand_tone || 'professional'}

Return exactly:
{
  "campaign_name": "string",
  "daily_budget_usd": ${dailyBudget},
  "keywords": [
    { "text": "keyword 1", "match_type": "PHRASE" },
    { "text": "keyword 2", "match_type": "EXACT" },
    { "text": "keyword 3", "match_type": "BROAD" },
    { "text": "keyword 4", "match_type": "PHRASE" },
    { "text": "keyword 5", "match_type": "EXACT" }
  ],
  "ad_groups": [
    {
      "name": "Ad Group 1 name",
      "keywords": ["kw1", "kw2"],
      "ads": [
        {
          "headline1": "max 30 chars",
          "headline2": "max 30 chars",
          "headline3": "max 30 chars",
          "description1": "max 90 chars",
          "description2": "max 90 chars"
        },
        {
          "headline1": "variation 2",
          "headline2": "max 30 chars",
          "headline3": "max 30 chars",
          "description1": "max 90 chars",
          "description2": "max 90 chars"
        }
      ]
    },
    {
      "name": "Ad Group 2 name",
      "keywords": ["kw3", "kw4", "kw5"],
      "ads": [
        {
          "headline1": "max 30 chars",
          "headline2": "max 30 chars",
          "headline3": "max 30 chars",
          "description1": "max 90 chars",
          "description2": "max 90 chars"
        }
      ]
    }
  ]
}`;

    const strategy = await callClaude(stratPrompt, 'strategy', 1500);
    const adGroups  = strategy.ad_groups || [];
    const campName  = strategy.campaign_name || `${biz.business_name} — Search — ${new Date().toISOString().slice(0, 10)}`;

    // 2. Create Campaign Budget
    const budgetResp = await googleAdsReq('POST',
      `customers/${customerId}/campaignBudgets:mutate`, token,
      { operations: [{ create: {
        name:             `${campName} Budget`,
        amountMicros:     String(dailyBudget * 1_000_000),
        deliveryMethod:   'STANDARD'
      }}]});

    if (budgetResp.status !== 200)
      throw new Error(`Budget create failed: ${JSON.stringify(budgetResp.body).slice(0, 300)}`);
    const budgetResourceName = budgetResp.body?.results?.[0]?.resourceName || '';

    // 3. Create Campaign
    const campResp = await googleAdsReq('POST',
      `customers/${customerId}/campaigns:mutate`, token,
      { operations: [{ create: {
        name:                    campName,
        status:                  'PAUSED',
        advertisingChannelType:  'SEARCH',
        campaignBudget:          budgetResourceName,
        networkSettings: {
          targetGoogleSearch:    true,
          targetSearchNetwork:   true,
          targetContentNetwork:  false
        },
        biddingStrategyType:     'MANUAL_CPC'
      }}]});

    if (campResp.status !== 200)
      throw new Error(`Campaign create failed: ${JSON.stringify(campResp.body).slice(0, 300)}`);
    const campaignResourceName = campResp.body?.results?.[0]?.resourceName || '';
    const googleCampaignId     = campaignResourceName.split('/').pop();

    // 4. Create Ad Groups, Ads, Keywords
    let firstAdGroupId = null;
    for (const ag of adGroups.slice(0, 2)) {
      // Ad Group
      const agResp = await googleAdsReq('POST',
        `customers/${customerId}/adGroups:mutate`, token,
        { operations: [{ create: {
          name:           ag.name || `Ad Group — ${biz.business_name}`,
          campaign:       campaignResourceName,
          status:         'ENABLED',
          cpcBidMicros:   String(Math.round((biz.target_cpc || 1.5) * 1_000_000))
        }}]});
      if (agResp.status !== 200) continue;
      const agResourceName = agResp.body?.results?.[0]?.resourceName || '';
      if (!firstAdGroupId) firstAdGroupId = agResourceName.split('/').pop();

      // Keywords
      const kwOps = (ag.keywords || []).map(kw => ({
        create: {
          adGroup:  agResourceName,
          status:   'ENABLED',
          keyword:  { text: typeof kw === 'string' ? kw : kw.text, matchType: kw.match_type || 'BROAD' }
        }
      }));
      if (kwOps.length) {
        await googleAdsReq('POST', `customers/${customerId}/adGroupCriteria:mutate`, token, { operations: kwOps });
      }

      // Ads (Responsive Search Ads)
      for (const ad of (ag.ads || []).slice(0, 2)) {
        const truncate = (s, n) => (s || '').slice(0, n);
        const adOp = { create: {
          adGroup: agResourceName,
          status:  'ENABLED',
          ad: {
            finalUrls: [`https://www.google.com`], // placeholder — update with real URL
            responsiveSearchAd: {
              headlines: [
                { text: truncate(ad.headline1, 30) },
                { text: truncate(ad.headline2, 30) },
                { text: truncate(ad.headline3, 30) }
              ].filter(h => h.text),
              descriptions: [
                { text: truncate(ad.description1, 90) },
                { text: truncate(ad.description2, 90) }
              ].filter(d => d.text)
            }
          }
        }};
        await googleAdsReq('POST', `customers/${customerId}/adGroupAds:mutate`, token, { operations: [adOp] });
      }
    }

    // 5. Save to ad_campaigns
    const campaignRow = await sbPost('ad_campaigns', {
      business_id,
      platform:             'google',
      google_campaign_id:   googleCampaignId,
      google_ad_group_id:   firstAdGroupId || null,
      status:               'paused',
      daily_budget:         dailyBudget,
      objective:            'SEARCH_LEADS',
      ai_strategy:          strategy,
      creatives:            adGroups.flatMap(ag => (ag.ads || []).map(a => ({ headline: a.headline1 })))
    });

    // 6. Review email
    const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1e293b">
  <h2 style="color:#4285f4">🔍 Your Google Search Campaign is Ready</h2>
  <p>Hi ${biz.first_name || biz.business_name},</p>
  <p>Your AI built a Google Search Ads campaign for <strong>${biz.business_name}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Campaign</td><td style="padding:8px 12px">${campName}</td></tr>
    <tr><td style="padding:8px 12px;font-weight:600">Ad Groups</td><td style="padding:8px 12px">${adGroups.length}</td></tr>
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Daily Budget</td><td style="padding:8px 12px">$${dailyBudget}</td></tr>
    <tr><td style="padding:8px 12px;font-weight:600">Status</td><td style="padding:8px 12px">⏸️ Paused — awaiting review</td></tr>
  </table>
  <a href="https://ads.google.com/aw/campaigns?campaignId=${googleCampaignId}"
     style="display:inline-block;background:#4285f4;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">
    Review in Google Ads →
  </a>
</div>`;
    await sendEmail(biz.email, `Your Google Ads campaign is ready for review — ${biz.business_name}`, html);
    log('/webhook/google-campaign-create', `✅ Google campaign ${googleCampaignId} — ${adGroups.length} ad groups`);

  } catch (err) {
    console.error('[google-campaign-create ERROR]', err.message);
    await logError(business_id, 'google-campaign-create', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/google-campaign-activate
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/google-campaign-activate', planGate('paid_ads'), async (req, res) => {
  const { business_id, campaign_id } = req.body;
  if (!business_id || !campaign_id)
    return res.status(400).json({ error: 'business_id and campaign_id required' });
  try {
    const camp = (await sbGet('ad_campaigns', `id=eq.${campaign_id}&business_id=eq.${business_id}`))[0];
    if (!camp)               return res.status(404).json({ error: 'Campaign not found' });
    if (camp.platform !== 'google') return res.status(400).json({ error: 'Not a Google campaign' });

    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=google_access_token,google_ads_customer_id`))[0];
    if (!biz?.google_access_token) return res.status(400).json({ error: 'google_ads_not_connected' });

    const customerId   = gCid(biz.google_ads_customer_id);
    const resourceName = `customers/${customerId}/campaigns/${camp.google_campaign_id}`;

    await googleAdsReq('POST', `customers/${customerId}/campaigns:mutate`, biz.google_access_token,
      { operations: [{ update: { resourceName, status: 'ENABLED' },
        updateMask: 'status' }]});

    await sbPatch('ad_campaigns', `id=eq.${campaign_id}`, { status: 'active' });
    res.json({ activated: true, campaign_id, google_campaign_id: camp.google_campaign_id });
  } catch (err) {
    console.error('[google-campaign-activate ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/google-campaign-optimize
// Pulls performance via Google Ads Reporting API, calls Claude Opus, adjusts budget.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/google-campaign-optimize', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Google Ads optimization started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,marketing_goal,target_cpc,avg_order_value,` +
      `google_access_token,google_ads_customer_id`))[0];
    if (!biz?.google_ads_customer_id || !biz?.google_access_token) return;

    const customerId = gCid(biz.google_ads_customer_id);
    const token      = biz.google_access_token;
    const campaigns  = await sbGet('ad_campaigns',
      `business_id=eq.${business_id}&platform=eq.google&status=eq.active`);

    let optimizedCount = 0;
    const actionsTaken  = [];

    for (const camp of campaigns) {
      try {
        // Google Ads query for campaign performance (last 7 days)
        const gaqlQuery = `
          SELECT campaign.id, campaign.name, campaign.status,
                 metrics.impressions, metrics.clicks, metrics.cost_micros,
                 metrics.conversions, metrics.ctr, metrics.average_cpc
          FROM campaign
          WHERE campaign.resource_name = 'customers/${customerId}/campaigns/${camp.google_campaign_id}'
            AND segments.date DURING LAST_7_DAYS`;

        const perfResp = await googleAdsReq('POST',
          `customers/${customerId}/googleAds:searchStream`, token,
          { query: gaqlQuery });

        if (perfResp.status !== 200) continue;

        const row = perfResp.body?.[0]?.results?.[0];
        if (!row) continue;

        const impressions = parseInt(row.metrics?.impressions  || 0);
        const clicks      = parseInt(row.metrics?.clicks       || 0);
        const costMicros  = parseInt(row.metrics?.costMicros   || 0);
        const spend       = costMicros / 1_000_000;
        const conversions = parseFloat(row.metrics?.conversions || 0);
        const ctr         = parseFloat(row.metrics?.ctr        || 0) * 100;
        const avgCpcMicros= parseInt(row.metrics?.averageCpc   || 0);
        const cpc         = avgCpcMicros / 1_000_000;
        const revenue     = conversions * (biz.avg_order_value || 50);
        const roas        = spend > 0 ? revenue / spend : 0;
        const targetCpc   = parseFloat(biz.target_cpc || 2.00);

        // Update analytics snapshot
        const today = new Date().toISOString().slice(0, 10);
        try {
          await sbUpsert('analytics_snapshots',
            { business_id, snapshot_date: today, platform: 'google_ads',
              impressions, clicks, engagement: Math.round(conversions) },
            'business_id,snapshot_date,platform');
        } catch { /* non-critical */ }

        // Claude Opus — optimization decision
        const decisionPrompt =
`You are a Google Ads optimizer. What action should be taken?

Campaign: ${camp.google_campaign_id}
Spend (7d): $${spend.toFixed(2)} | Impressions: ${impressions} | Clicks: ${clicks}
CTR: ${ctr.toFixed(2)}% | CPC: $${cpc.toFixed(2)} | Conversions: ${conversions} | ROAS: ${roas.toFixed(2)}x
Target CPC: $${targetCpc.toFixed(2)} | Goal: ${biz.marketing_goal || 'grow leads'}

Rules: ROAS > 3 OR CTR > 5% → increase_budget (+20%). CTR < 1% AND spend > $5 → decrease_budget (-20%).
CPC > target * 2 AND spend > $10 → decrease_budget (-30%). 0 conv AND spend > $30 AND CTR < 0.5% → pause.
ROAS < 1 AND spend > $20 → refresh_creative. Otherwise → keep.

Return ONLY JSON: {"action":"increase_budget"|"decrease_budget"|"pause"|"refresh_creative"|"keep","reason":"string","budget_change_pct":0}`;

        const decision  = await callClaude(decisionPrompt, 'strategy', 400);
        const action    = decision.action || 'keep';
        const reason    = decision.reason || 'Performance within normal range';
        const changePct = decision.budget_change_pct || 0;

        // Execute action via Google Ads API
        if (action === 'increase_budget' || action === 'decrease_budget') {
          const currentBudget = camp.daily_budget || 10;
          const newBudget     = Math.max(1, Math.round(currentBudget * (1 + changePct / 100)));
          // Update campaign budget (need the budget resource name)
          const budgetResourceName = `customers/${customerId}/campaignBudgets/${camp.google_campaign_id}`;
          await googleAdsReq('POST', `customers/${customerId}/campaignBudgets:mutate`, token,
            { operations: [{ update: {
              resourceName: budgetResourceName,
              amountMicros: String(newBudget * 1_000_000)
            }, updateMask: 'amountMicros' }]});
          await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { daily_budget: newBudget });
        } else if (action === 'pause') {
          await googleAdsReq('POST', `customers/${customerId}/campaigns:mutate`, token,
            { operations: [{ update: {
              resourceName: `customers/${customerId}/campaigns/${camp.google_campaign_id}`,
              status:       'PAUSED'
            }, updateMask: 'status' }]});
        }

        await sbPatch('ad_campaigns', `id=eq.${camp.id}`, {
          last_decision:        action,
          last_decision_reason: reason,
          last_optimized_at:    new Date().toISOString(),
          impressions, clicks,
          total_spend:          spend,
          roas,
          ...(action === 'pause' ? { status: 'paused', paused_reason: reason } : {})
        });

        actionsTaken.push({ campaign_id: camp.id, action, reason });
        optimizedCount++;
      } catch (ce) {
        log('/webhook/google-campaign-optimize', `Campaign ${camp.id} error: ${ce.message}`);
        await logError(business_id, 'google-campaign-optimize', ce.message, { campaign_id: camp.id });
      }
    }
    log('/webhook/google-campaign-optimize',
      `✅ Optimized ${optimizedCount}/${campaigns.length} Google campaigns for ${business_id}`);
  } catch (err) {
    console.error('[google-campaign-optimize ERROR]', err.message);
    await logError(business_id, 'google-campaign-optimize', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/google-campaigns-get?business_id=X
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/google-campaigns-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const campaigns = await sbGet('ad_campaigns',
      `business_id=eq.${business_id}&platform=eq.google&order=created_at.desc`);
    const summary = {
      total:       campaigns.length,
      active:      campaigns.filter(c => c.status === 'active').length,
      paused:      campaigns.filter(c => c.status === 'paused').length,
      total_spend: campaigns.reduce((a, c) => a + parseFloat(c.total_spend || 0), 0).toFixed(2),
      avg_roas:    campaigns.length
        ? (campaigns.reduce((a, c) => a + parseFloat(c.roas || 0), 0) / campaigns.length).toFixed(2)
        : '0.00'
    };
    res.json({ campaigns, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SPRINT 4 — CRM + COMPETITOR INTELLIGENCE + CONTENT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// ── Lead score weights ────────────────────────────────────────────────────────
const SCORE_WEIGHTS = {
  email_open:5, email_click:10, page_visit:3, form_fill:20,
  ad_click:8, purchase:50, meeting:30, call:15, email_bounce:-5
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/contact-create
// UPSERT contact, log activity, auto-enroll in signup sequence.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/contact-create', async (req, res) => {
  const { business_id, email, first_name, last_name, phone, company, source = 'manual', tags = [] } = req.body;
  if (!business_id || !email) return res.status(400).json({ error: 'business_id and email required' });

  try {
    // UPSERT via REST: POST with Prefer: resolution=merge-duplicates
    const r = await apiRequest('POST',
      `${SUPABASE_URL}/rest/v1/contacts`,
      { ...sbH(), 'Content-Type': 'application/json', 'Prefer': 'return=representation,resolution=merge-duplicates' },
      { business_id, email, first_name, last_name, phone, company, source,
        tags, last_activity_at: new Date().toISOString() });

    if (![200,201].includes(r.status))
      throw new Error(`contact upsert: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);

    const contact = Array.isArray(r.body) ? r.body[0] : r.body;
    const contact_id = contact?.id;
    if (!contact_id) throw new Error('No contact id returned');

    // Log creation activity
    await sbPost('contact_activities', {
      business_id, contact_id, activity_type: 'contact_created', metadata: { source }
    });

    // Auto-enroll in 'signup' sequence if one exists
    let enrolled = false;
    try {
      const seqs = await sbGet('email_sequences',
        `business_id=eq.${business_id}&trigger_type=eq.signup&is_active=eq.true&limit=1`);
      if (seqs[0]) {
        await sbPost('contact_enrollments', {
          business_id, contact_email: email,
          contact_name: [first_name, last_name].filter(Boolean).join(' ') || email,
          sequence_id: seqs[0].id, current_step: 0, status: 'active',
          next_send_at: new Date().toISOString()
        });
        enrolled = true;
      }
    } catch {}

    res.json({ success: true, contact_id, enrolled_in_sequence: enrolled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/contact-update
// Update arbitrary fields on a contact.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/contact-update', async (req, res) => {
  const { contact_id, ...fields } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
  delete fields.id; delete fields.business_id; delete fields.created_at;
  try {
    await sbPatch('contacts', `id=eq.${contact_id}`, {
      ...fields, last_activity_at: new Date().toISOString()
    });
    res.json({ success: true, contact_id, updated: fields });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/contact-import
// Bulk UPSERT contacts from CSV array. Dedupe on (business_id, email).
// Body: { business_id, contacts: [{email, first_name, ...}] }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/contact-import', async (req, res) => {
  const { business_id, contacts = [] } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!contacts.length) return res.json({ imported: 0, updated: 0, failed: 0 });

  let imported = 0, updated = 0, failed = 0;
  for (const c of contacts) {
    if (!c.email) { failed++; continue; }
    try {
      // Check if exists
      const existing = await sbGet('contacts', `business_id=eq.${business_id}&email=eq.${encodeURIComponent(c.email)}&select=id`);
      await apiRequest('POST', `${SUPABASE_URL}/rest/v1/contacts`,
        { ...sbH(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal,resolution=merge-duplicates' },
        { business_id, source: 'import', ...c, last_activity_at: new Date().toISOString() });
      existing.length ? updated++ : imported++;
    } catch { failed++; }
  }
  res.json({ imported, updated, failed, total: contacts.length });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/contacts-get
// ?business_id=X [&stage=X] [&min_score=X] [&limit=50] [&offset=0]
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/contacts-get', async (req, res) => {
  const { business_id, stage, min_score, limit = 50, offset = 0 } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    let filter = `business_id=eq.${business_id}&order=lead_score.desc&limit=${limit}&offset=${offset}`;
    if (stage)     filter += `&stage=eq.${stage}`;
    if (min_score) filter += `&lead_score=gte.${min_score}`;

    const contacts = await sbGet('contacts', filter);

    // Count total (without limit)
    let countFilter = `business_id=eq.${business_id}`;
    if (stage)     countFilter += `&stage=eq.${stage}`;
    if (min_score) countFilter += `&lead_score=gte.${min_score}`;
    const countR = await apiRequest('GET',
      `${SUPABASE_URL}/rest/v1/contacts?${countFilter}&select=id`,
      { ...sbH(), 'Prefer': 'count=exact' });
    const total = parseInt(countR.body?.length || contacts.length);

    res.json({ contacts, total, limit: Number(limit), offset: Number(offset) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/contact-activity-log  — UPGRADE 6: AI LEAD SCORING
// Log activity, use Claude Sonnet to evaluate full contact history,
// returns score 0-100 + intent_level + recommended_action.
// If ready_to_buy: enroll in priority sequence + send alert email.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/contact-activity-log', async (req, res) => {
  const { business_id, contact_id, activity_type, metadata = {} } = req.body;
  if (!business_id || !contact_id || !activity_type)
    return res.status(400).json({ error: 'business_id, contact_id, activity_type required' });
  if (!isUUID(contact_id)) return res.status(400).json({ error: 'contact_id must be a valid UUID' });

  try {
    // Insert activity
    await sbPost('contact_activities', { business_id, contact_id, activity_type, metadata });

    // Fetch full contact + all activities for AI scoring
    const [contactArr, activities, bizArr] = await Promise.all([
      sbGet('contacts', `id=eq.${contact_id}&select=*&limit=1`),
      sbGet('contact_activities', `contact_id=eq.${contact_id}&select=activity_type,metadata,created_at&order=created_at.desc&limit=30`),
      sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,email`)
    ]);
    const contact  = contactArr[0];
    const biz      = bizArr[0];
    const old_score = contact?.lead_score || 0;
    const old_stage = contact?.stage || 'lead';
    const old_intent = contact?.intent_level || 'cold';

    // ── Static score as baseline (fast) ──────────────────────────────────
    const staticScore = activities.reduce((sum, a) =>
      sum + (SCORE_WEIGHTS[a.activity_type] || 0), 0);

    // ── AI scoring with Claude Sonnet (full context) ─────────────────────
    let aiScore = staticScore;
    let intentLevel = old_intent;
    let recommendedAction = '';

    // Only call Claude if there are enough activities to justify it
    if (activities.length >= 3) {
      try {
        const activitySummary = activities.map(a =>
          `${a.activity_type} at ${a.created_at}${a.metadata ? ' | ' + JSON.stringify(a.metadata) : ''}`
        ).join('\n');

        const prompt =
`You are an AI lead scoring engine. Evaluate this contact's buying intent.

CONTACT: ${contact?.first_name || ''} ${contact?.last_name || ''} (${contact?.email || ''})
SOURCE: ${contact?.source || 'unknown'} | CURRENT STAGE: ${old_stage}
COMPANY: ${contact?.company || 'unknown'}
BUSINESS: ${biz?.business_name || ''} (${biz?.industry || ''})

FULL ACTIVITY HISTORY (most recent first):
${activitySummary}

SCORING GUIDE:
- email_open=5, email_click=10, page_visit=3, form_fill=20, ad_click=8, purchase=50, meeting=30, call=15

Evaluate the PATTERN of behavior, not just the sum. Consider:
- Recency (recent activity = higher intent)
- Frequency (multiple touches = building interest)
- Depth (form fills, meetings > casual opens)
- Velocity (how fast they're moving through the funnel)

Return ONLY valid JSON:
{
  "score": 0-100,
  "intent_level": "cold" | "warm" | "hot" | "ready_to_buy",
  "recommended_action": "specific next step",
  "reasoning": "1-2 sentences why"
}`;

        const aiResult = await callClaude(prompt, 'social_post', 500);
        if (aiResult.score !== undefined) aiScore = Math.max(0, Math.min(100, aiResult.score));
        if (aiResult.intent_level) intentLevel = aiResult.intent_level;
        if (aiResult.recommended_action) recommendedAction = aiResult.recommended_action;
      } catch (aiErr) {
        log('/webhook/contact-activity-log', `AI scoring fallback to static: ${aiErr.message}`);
      }
    }

    // ── Update contact ──────────────────────────────────────────────────
    const updates = {
      lead_score: aiScore,
      intent_level: intentLevel,
      recommended_action: recommendedAction,
      last_activity_at: new Date().toISOString()
    };
    let stage_changed = false;

    // Auto-qualify if score >= 50 and still a lead
    if (old_score < 50 && aiScore >= 50 && old_stage === 'lead') {
      updates.stage = 'qualified';
      stage_changed = true;
    }

    // Auto-escalate: ready_to_buy → enroll in priority sequence + alert
    if (intentLevel === 'ready_to_buy' && old_intent !== 'ready_to_buy') {
      updates.stage = 'opportunity';
      stage_changed = true;

      // Enroll in priority / ready_to_buy sequence
      try {
        const seqs = await sbGet('email_sequences',
          `business_id=eq.${business_id}&trigger_type=eq.ready_to_buy&is_active=eq.true&limit=1`);
        // Fall back to qualified sequence
        const seq = seqs[0] || (await sbGet('email_sequences',
          `business_id=eq.${business_id}&trigger_type=eq.qualified&is_active=eq.true&limit=1`))[0];
        if (seq && contact) {
          await sbPost('contact_enrollments', {
            business_id, contact_email: contact.email,
            contact_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
            sequence_id: seq.id, current_step: 0, status: 'active',
            next_send_at: new Date().toISOString()
          });
        }
      } catch {}

      // Send alert email to business owner
      if (biz?.email && contact) {
        const html = `<h2>🔥 Ready-to-Buy Lead Detected!</h2>
<p><strong>${contact.first_name || ''} ${contact.last_name || ''}</strong> (${contact.email}) scored <strong>${aiScore}/100</strong> and is ready to buy.</p>
<p><strong>Recommended action:</strong> ${recommendedAction}</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/crm" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View in CRM</a></p>`;
        sendEmail(biz.email, `🔥 ${contact.first_name || 'Lead'} is ready to buy — ${biz.business_name}`, html).catch(() => {});
      }
    }

    await sbPatch('contacts', `id=eq.${contact_id}`, updates);
    try { if (intentLevel === 'ready_to_buy' || aiScore >= 75) storeInsight(business_id, 'leads', 'lead_intelligence', 'lead_quality_pattern', `Score ${aiScore}, intent: ${intentLevel}, source: ${contact?.source || 'unknown'}`); } catch {}
    res.json({
      success: true, new_score: aiScore, old_score,
      intent_level: intentLevel, recommended_action: recommendedAction,
      stage_changed, ai_scored: activities.length >= 3
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/pipeline-get?business_id=X
// Deals grouped by stage + top contacts by score.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/pipeline-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const [deals, top_contacts] = await Promise.all([
      sbGet('deals', `business_id=eq.${business_id}&order=created_at.desc`),
      sbGet('contacts', `business_id=eq.${business_id}&order=lead_score.desc&limit=10&select=id,email,first_name,last_name,lead_score,stage`)
    ]);

    const stages = ['new','contacted','proposal','negotiation','won','lost'];
    const pipeline = stages.reduce((acc, s) => {
      const group = deals.filter(d => d.stage === s);
      acc[s] = {
        count: group.length,
        value: group.reduce((sum, d) => sum + parseFloat(d.value || 0), 0).toFixed(2),
        deals: group
      };
      return acc;
    }, {});

    const total_value = deals.reduce((sum, d) => sum + parseFloat(d.value || 0), 0).toFixed(2);
    const weighted_value = deals.reduce((sum, d) =>
      sum + parseFloat(d.value || 0) * (d.probability || 0) / 100, 0).toFixed(2);

    res.json({ pipeline, total_value, weighted_value, total_deals: deals.length, top_contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/deal-create
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/deal-create', async (req, res) => {
  const { business_id, contact_id, title, value = 0, stage = 'new', probability = 0, expected_close_date, notes } = req.body;
  if (!business_id || !title) return res.status(400).json({ error: 'business_id and title required' });
  try {
    const deal = await sbPost('deals', { business_id, contact_id, title, value, stage, probability, expected_close_date, notes });
    res.json({ success: true, deal_id: deal?.id, deal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/deal-stage-update
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/deal-stage-update', async (req, res) => {
  const { deal_id, stage, probability, notes } = req.body;
  if (!deal_id || !stage) return res.status(400).json({ error: 'deal_id and stage required' });
  try {
    const updates = { stage };
    if (probability !== undefined) updates.probability = probability;
    if (notes)                      updates.notes       = notes;
    await sbPatch('deals', `id=eq.${deal_id}`, updates);
    res.json({ success: true, deal_id, stage });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/competitor-analyze
// Full competitor intelligence run for one business.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/competitor-analyze', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  // Return immediately — analysis runs in background (~30-60s)
  res.json({ received: true, message: 'Competitor analysis started — report ready in ~60 seconds' });

  setImmediate(async () => {
    try {
      const bizArr = await sbGet('businesses',
        `id=eq.${business_id}&select=business_name,industry,location,competitors,email,first_name`);
      const biz = bizArr[0];
      if (!biz) return;

      let competitors = [];
      try { competitors = JSON.parse(biz.competitors || '[]'); } catch {}
      if (!competitors.length) {
        // Fall back to SerpAPI to find top competitors
        if (SERPAPI_KEY) {
          try {
            const sr = await apiRequest('GET',
              `https://serpapi.com/search.json?q=${encodeURIComponent(`${biz.industry} competitors ${biz.location || ''}`)}&num=5&api_key=${SERPAPI_KEY}`);
            const organic = sr.body?.organic_results || [];
            competitors = organic.slice(0, 3).map(r => r.displayed_link || r.link).filter(Boolean);
          } catch {}
        }
        if (!competitors.length) competitors = [`top ${biz.industry} company`];
      }

      const snapshots = [];
      const today = new Date().toISOString().split('T')[0];

      for (const comp of competitors.slice(0, 5)) {
        const compName = typeof comp === 'string' ? comp : (comp.name || comp);
        let serpData = {}, adData = {};

        // SerpAPI: brand search
        if (SERPAPI_KEY) {
          try {
            const sr = await apiRequest('GET',
              `https://serpapi.com/search.json?q=${encodeURIComponent(compName)}&num=5&api_key=${SERPAPI_KEY}`);
            serpData = sr.body || {};
          } catch {}
          // SerpAPI: ad search
          try {
            const ar = await apiRequest('GET',
              `https://serpapi.com/search.json?q=${encodeURIComponent(`${compName} ads`)}&num=5&api_key=${SERPAPI_KEY}`);
            adData = ar.body || {};
          } catch {}
        }

        const keyword_rankings = (serpData.organic_results || []).slice(0, 5).map(r => ({
          keyword: r.title?.slice(0, 60), url: r.link, position: r.position
        }));
        const active_ads = (adData.ads || []).slice(0, 5).map(a => ({
          headline: a.title, description: a.snippet, url: a.link
        }));

        // Save snapshot
        try {
          await sbPost('competitor_snapshots', {
            business_id, competitor_name: compName,
            snapshot_date: today, keyword_rankings, active_ads
          });
        } catch {}

        snapshots.push({ name: compName, keyword_rankings, active_ads });
      }

      // Claude Opus — competitive intelligence analysis
      const analyzePrompt =
`You are a competitive intelligence analyst for ${biz.business_name} (${biz.industry}).

Competitor data gathered this week:
${JSON.stringify(snapshots, null, 2)}

Analyze and return ONLY valid JSON:
{
  "new_offers": ["string describing any promotions or offers spotted"],
  "content_themes": ["topics competitors are focusing on"],
  "ad_angles": ["ad hooks and angles competitors are using"],
  "pricing_changes": ["any pricing signals found"],
  "recommendation": "one specific strategic action ${biz.business_name} should take this week based on this intelligence"
}`;

      const analysis = await callClaude(analyzePrompt, 'strategy', 1500);

      // Save report
      const report = await sbPost('competitor_reports', {
        business_id, report_date: today,
        new_offers:      analysis.new_offers      || [],
        content_themes:  analysis.content_themes  || [],
        ad_angles:       analysis.ad_angles       || [],
        pricing_changes: analysis.pricing_changes || [],
        recommendation:  analysis.recommendation  || '',
        raw_analysis:    analysis
      });

      // Also update legacy competitor_insights table
      try {
        await sbPost('competitor_insights', {
          business_id,
          competitor_doing_well: (analysis.ad_angles || []).join('; ').slice(0, 300),
          gap_opportunity:       (analysis.content_themes || []).join('; ').slice(0, 300),
          content_to_steal:      (analysis.new_offers || []).join('; ').slice(0, 300),
          positioning_tip:       analysis.recommendation || ''
        });
      } catch {}

      log('/webhook/competitor-analyze',
        `✅ ${snapshots.length} competitors analyzed | report: ${report?.id}`);
    } catch (err) {
      console.error('[competitor-analyze ERROR]', err.message);
      await logError(business_id, 'competitor-analyze', err.message, {}).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/competitor-report-get?business_id=X
// Latest competitor report for a business.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/competitor-report-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const [reports, snapshots] = await Promise.all([
      sbGet('competitor_reports', `business_id=eq.${business_id}&order=report_date.desc&limit=5`),
      sbGet('competitor_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=10`)
    ]);
    res.json({ latest_report: reports[0] || null, recent_reports: reports, recent_snapshots: snapshots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/content-generate
// Generate blog / landing_page / video_script via Claude + optionally image.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/content-generate', async (req, res) => {
  const { business_id, type = 'blog', target_keyword, topic } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!['blog','landing_page','video_script','email_template'].includes(type))
    return res.status(400).json({ error: 'type must be blog|landing_page|video_script|email_template' });

  // Return immediately — generation happens in background
  res.json({ received: true, message: `${type} generation started — check email in ~2 minutes` });

  setImmediate(async () => {
    try {
      const bizArr = await sbGet('businesses',
        `id=eq.${business_id}&select=business_name,industry,location,target_audience,brand_tone,marketing_goal,email,first_name`);
      const biz = bizArr[0];
      if (!biz) return;

      let keyword = target_keyword;
      // Auto-discover keyword via SerpAPI if not provided (blog only)
      if (type === 'blog' && !keyword && SERPAPI_KEY) {
        try {
          const sr = await apiRequest('GET',
            `https://serpapi.com/search.json?q=${encodeURIComponent(`${biz.industry} tips`)}&num=10&api_key=${SERPAPI_KEY}`);
          const queries = sr.body?.related_searches || [];
          keyword = queries[0]?.query || `${biz.industry} tips for ${biz.target_audience || 'small businesses'}`;
        } catch { keyword = `${biz.industry} tips for ${biz.target_audience || 'businesses'}`; }
      }
      keyword = keyword || topic || `${biz.industry} guide`;

      let prompt = '';
      let claudeTask = 'strategy';
      let maxTok = 3000;

      if (type === 'blog') {
        prompt =
`Write a complete SEO blog post for ${biz.business_name} (${biz.industry}).
Target keyword: "${keyword}"
Tone: ${biz.brand_tone || 'professional'} | Location: ${biz.location || 'United States'}

Write 1200-1500 words with H1 title, H2 subheadings, intro, body sections, conclusion, and CTA.
Return ONLY valid JSON:
{
  "title": "H1 headline with keyword",
  "body": "full blog post in plain text with section headers marked as ## Header",
  "meta_description": "155-char max SEO meta description",
  "seo_score": 75,
  "word_count": 1300
}`;

      } else if (type === 'landing_page') {
        prompt =
`Write complete landing page copy for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'generate leads'} | Audience: ${biz.target_audience || 'general consumers'}
Tone: ${biz.brand_tone || 'professional'}

Sections: Hero headline + subheadline, 3 key benefits, social proof placeholder, 3-question FAQ, CTA section.
Return ONLY valid JSON:
{
  "title": "page headline",
  "body": "full landing page copy with section breaks",
  "meta_description": "155-char meta description",
  "seo_score": 70,
  "word_count": 800
}`;

      } else if (type === 'video_script') {
        claudeTask = 'social_post';
        maxTok = 1500;
        prompt =
`Write a 60-second video script for ${biz.business_name} (${biz.industry}).
Format: Hook(0-5s), Problem(5-15s), Solution(15-40s), Proof(40-50s), CTA(50-60s).
Tone: ${biz.brand_tone || 'energetic'} | Audience: ${biz.target_audience || 'small business owners'}

Return ONLY valid JSON:
{
  "title": "video title for YouTube/TikTok",
  "body": "full script with timestamps e.g. [0-5s] Hook: ...",
  "meta_description": "video description for YouTube (250 chars)",
  "seo_score": 65,
  "word_count": 200
}`;

      } else {
        // email_template
        claudeTask = 'email';
        maxTok = 1200;
        prompt =
`Write a marketing email template for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'nurture leads'} | Tone: ${biz.brand_tone || 'friendly'}

Return ONLY valid JSON:
{
  "title": "email subject line",
  "body": "full email body in plain text",
  "meta_description": "email preview text (90 chars max)",
  "seo_score": 60,
  "word_count": 350
}`;
      }

      const content = await callClaude(prompt, claudeTask, maxTok);

      // Generate featured image for blog posts → save to Supabase Storage
      let featured_image_url = null;
      if (type === 'blog' && content.title) {
        try {
          const imgResult = await generateSmartImage(business_id, `Professional blog header image for: ${content.title}. ${biz.industry} themed, modern, clean.`, 'blog_featured', biz.plan || 'free');
          featured_image_url = imgResult?.url || null;
        } catch {}
      }

      // Save to content_pieces
      const piece = await sbPost('content_pieces', {
        business_id,
        type,
        title:              content.title        || keyword,
        target_keyword:     keyword,
        body:               content.body         || '',
        meta_description:   content.meta_description || '',
        featured_image_url,
        status:             'ready_for_review',
        word_count:         content.word_count   || 0,
        seo_score:          content.seo_score    || 0
      });

      // Send notification email
      if (biz.email) {
        const typeLabel = type.replace('_', ' ');
        const html = `
<h2>New ${typeLabel} ready for review</h2>
<p><strong>Title:</strong> ${content.title || keyword}</p>
<p><strong>Word count:</strong> ${content.word_count || 0} words</p>
<p><strong>SEO score:</strong> ${content.seo_score || 0}/100</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/content" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve</a></p>`;
        await sendEmail(biz.email, `New ${typeLabel} ready: ${content.title || keyword}`, html).catch(() => {});
      }

      log('/webhook/content-generate',
        `✅ ${type} created | id: ${piece?.id} | words: ${content.word_count}`);
    } catch (err) {
      console.error('[content-generate ERROR]', err.message);
      await logError(business_id, 'content-generate', err.message, req.body).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/content-pieces-get?business_id=X[&type=X][&status=X]
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/content-pieces-get', async (req, res) => {
  const { business_id, type, status, limit = 20, offset = 0 } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    let filter = `business_id=eq.${business_id}&order=created_at.desc&limit=${limit}&offset=${offset}`;
    if (type)   filter += `&type=eq.${type}`;
    if (status) filter += `&status=eq.${status}`;
    const pieces = await sbGet('content_pieces', filter);
    const summary = {
      total:           pieces.length,
      by_type:         pieces.reduce((a, p) => { a[p.type] = (a[p.type]||0)+1; return a; }, {}),
      by_status:       pieces.reduce((a, p) => { a[p.status]= (a[p.status]||0)+1; return a; }, {}),
      avg_seo_score:   pieces.length
        ? Math.round(pieces.reduce((s,p) => s+(p.seo_score||0),0)/pieces.length) : 0,
      avg_word_count:  pieces.length
        ? Math.round(pieces.reduce((s,p) => s+(p.word_count||0),0)/pieces.length) : 0
    };
    res.json({ pieces, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/content-approve
// Approve a content piece and optionally mark it published.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/content-approve', async (req, res) => {
  const piece_id = req.body.piece_id || req.body.content_id;
  const { published_url } = req.body;
  if (!piece_id) return res.status(400).json({ error: 'piece_id required' });
  if (!isUUID(piece_id)) return res.status(400).json({ error: 'piece_id must be a valid UUID' });
  try {
    const updates = { status: published_url ? 'published' : 'approved' };
    if (published_url) updates.published_url = published_url;
    await sbPatch('content_pieces', `id=eq.${piece_id}`, updates);
    res.json({ success: true, piece_id, status: updates.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SPRINT 6 — SEO AUTOPILOT + CRO ENGINE + VIDEO GENERATION
// ─────────────────────────────────────────────────────────────────────────────

// ── HTML parser helpers ───────────────────────────────────────────────────────
function extractMetaTag(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
         || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'));
  return m ? m[1].trim() : null;
}
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}
function hasLdJsonSchema(html, type) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  return scripts.some(s => {
    try { const d = JSON.parse(s[1]); return (d['@type'] || '').toLowerCase().includes(type.toLowerCase()); }
    catch { return false; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/seo-audit
// Full SEO audit: keyword gaps + meta tags + schema. Runs async.
// Body: { business_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/seo-audit', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  res.json({ received: true, message: 'SEO audit started — recommendations ready in ~60 seconds' });

  setImmediate(async () => {
    try {
      const bizArr = await sbGet('businesses',
        `id=eq.${business_id}&select=business_name,industry,location,website_url,target_audience,competitors`);
      const biz = bizArr[0];
      if (!biz) return;
      if (!biz.website_url) {
        log('/webhook/seo-audit', `No website_url for ${business_id}`); return;
      }

      let competitors = [];
      try { competitors = JSON.parse(biz.competitors || '[]'); } catch {}

      let created = 0;
      const saveRec = async (type, current_value, recommended_value, target_keyword, priority, estimated_impact, url) => {
        try {
          await sbPost('seo_recommendations', {
            business_id, url: url || biz.website_url, type,
            current_value: (current_value || '').slice(0, 500),
            recommended_value: (recommended_value || '').slice(0, 500),
            target_keyword, priority, estimated_impact
          });
          created++;
        } catch (e) { log('/webhook/seo-audit', `saveRec error: ${e.message}`); }
      };

      // ── CHECK 1: Keyword gap + LOCAL SEO via SerpAPI ──────────────────────
      const kwGapPromise = (async () => {
        if (!SERPAPI_KEY) return;
        try {
          const loc = biz.location || '';
          const baseQuery = `${biz.industry} ${loc}`.trim();
          const bizResults = await serpSearch(baseQuery, 10);
          const bizLinks   = new Set(bizResults.map(r => r.link));

          for (const comp of competitors.slice(0, 3)) {
            const compName = typeof comp === 'string' ? comp : (comp.name || comp);
            const compQ    = `${compName} ${biz.industry}`;
            const compRes  = await serpSearch(compQ, 10);
            for (const r of compRes) {
              if (!bizLinks.has(r.link) && r.title) {
                const kw = r.title.split(' ').slice(0, 5).join(' ');
                await saveRec('keyword_gap', null,
                  `Target this keyword: "${kw}" — competitor ${compName} ranks here`,
                  kw, 'high', '+15-30% organic traffic', biz.website_url);
              }
            }
          }
          // Also add the base keyword if site doesn't rank
          if (!bizResults.some(r => (r.link || '').includes((biz.website_url || '').replace(/https?:\/\//, '').split('/')[0]))) {
            await saveRec('keyword_gap', null,
              `Optimise homepage for: "${baseQuery}"`,
              baseQuery, 'high', '+20% local organic traffic', biz.website_url);
          }

          // ── LOCAL SEO: geo-specific keyword gaps ────────────────────────────
          if (loc) {
            const localQueries = [
              `${biz.industry} in ${loc}`,
              `${biz.industry} near me`,
              `best ${biz.industry} ${loc}`
            ];
            for (const lq of localQueries) {
              const lRes = await serpSearch(lq, 5);
              const domain = (biz.website_url || '').replace(/https?:\/\//, '').split('/')[0];
              const isRanking = lRes.some(r => (r.link || '').includes(domain));
              if (!isRanking) {
                await saveRec('local_seo', null,
                  `Target local keyword: "${lq}" — not currently ranking`,
                  lq, 'high', '+25% local discovery traffic', biz.website_url);
              }
            }
          }
        } catch (e) { log('/webhook/seo-audit', `kwGap error: ${e.message}`); }
      })();

      // ── CHECK 2: Meta tag audit ───────────────────────────────────────────
      const metaPromise = (async () => {
        try {
          const fetchResp = await apiRequest('GET', biz.website_url.startsWith('http') ? biz.website_url : `https://${biz.website_url}`, {});
          const html = typeof fetchResp.body === 'string' ? fetchResp.body : JSON.stringify(fetchResp.body);

          const currentTitle = extractTitle(html);
          const currentDesc  = extractMetaTag(html, 'description');
          const baseKw       = `${biz.industry} ${biz.location || ''}`.trim();

          const needsTitle = !currentTitle || currentTitle.length > 60 || currentTitle.length < 10;
          const needsDesc  = !currentDesc  || currentDesc.length  > 155 || currentDesc.length < 50;

          if (needsTitle || needsDesc) {
            const metaPrompt =
`Write an SEO-optimized meta title (max 60 chars) and meta description (max 155 chars) for ${biz.business_name} (${biz.industry}).
Website: ${biz.website_url} | Target keyword: "${baseKw}" | Location: ${biz.location || 'United States'}
Make the title include the keyword. Make the description include a clear benefit + CTA.
Return ONLY valid JSON: { "meta_title": "...", "meta_description": "..." }`;
            const meta = await callClaude(metaPrompt, 'short_copy', 300);

            if (needsTitle)
              await saveRec('meta_title', currentTitle || '(missing)', meta.meta_title || '', baseKw, 'high',
                '+5-10% CTR in search results', biz.website_url);
            if (needsDesc)
              await saveRec('meta_description', currentDesc || '(missing)', meta.meta_description || '', baseKw, 'high',
                '+3-8% CTR in search results', biz.website_url);
          }
        } catch (e) { log('/webhook/seo-audit', `meta error: ${e.message}`); }
      })();

      // ── CHECK 3: Schema markup ────────────────────────────────────────────
      const schemaPromise = (async () => {
        try {
          const fetchResp = await apiRequest('GET', biz.website_url.startsWith('http') ? biz.website_url : `https://${biz.website_url}`, {});
          const html = typeof fetchResp.body === 'string' ? fetchResp.body : '';
          if (!hasLdJsonSchema(html, 'LocalBusiness') && !hasLdJsonSchema(html, 'Organization')) {
            const schemaPrompt =
`Generate a complete LocalBusiness JSON-LD schema for:
Business: ${biz.business_name}, Type: ${biz.industry}
Phone: ${biz.phone || 'N/A'}, Website: ${biz.website_url}
Address: ${biz.location || 'United States'}
Return ONLY the raw JSON-LD object (no markdown, no \`\`\`).`;
            const schemaResult = await callClaude(schemaPrompt, 'short_copy', 600);
            const schemaText = JSON.stringify(schemaResult);
            await saveRec('schema', '(no LocalBusiness schema found)',
              `<script type="application/ld+json">${schemaText}</script>`,
              null, 'medium', '+local SEO + rich results eligibility', biz.website_url);
          }
        } catch (e) { log('/webhook/seo-audit', `schema error: ${e.message}`); }
      })();

      await Promise.all([kwGapPromise, metaPromise, schemaPromise]);
      try { storeInsight(business_id, 'seo', 'seo_intelligence', 'recommendations_created', `${created} SEO recommendations`); } catch {}
      log('/webhook/seo-audit', `✅ ${business_id} — ${created} recommendations created`);
    } catch (err) {
      console.error('[seo-audit ERROR]', err.message);
      await logError(business_id, 'seo-audit', err.message, req.body).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/seo-recommendations-get?business_id=X[&status=X][&priority=X]
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/seo-recommendations-get', async (req, res) => {
  const { business_id, status, priority } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    // Priority order: high, medium, low
    let filter = `business_id=eq.${business_id}&order=created_at.desc`;
    if (status)   filter += `&status=eq.${status}`;
    if (priority) filter += `&priority=eq.${priority}`;

    const recs = await sbGet('seo_recommendations', filter);

    // Sort high → medium → low client-side
    const order = { high: 0, medium: 1, low: 2 };
    recs.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));

    const summary = {
      total:   recs.length,
      pending: recs.filter(r => r.status === 'pending').length,
      applied: recs.filter(r => r.status === 'applied').length,
      by_type: recs.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc; }, {}),
      by_priority: {
        high:   recs.filter(r => r.priority === 'high').length,
        medium: recs.filter(r => r.priority === 'medium').length,
        low:    recs.filter(r => r.priority === 'low').length
      }
    };

    res.json({ recommendations: recs, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/seo-recommendation-apply
// Mark a recommendation applied; return full details for frontend to show.
// Body: { business_id, recommendation_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/seo-recommendation-apply', async (req, res) => {
  const { business_id, recommendation_id } = req.body;
  if (!recommendation_id) return res.status(400).json({ error: 'recommendation_id required' });
  if (!isUUID(recommendation_id)) return res.status(400).json({ error: 'recommendation_id must be a valid UUID' });
  try {
    await sbPatch('seo_recommendations', `id=eq.${recommendation_id}`, { status: 'applied' });
    const rows = await sbGet('seo_recommendations', `id=eq.${recommendation_id}`);
    res.json({ success: true, recommendation: rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/cro-analyze
// Claude Opus generates 3 A/B test recommendations + saves to ab_tests.
// Body: { business_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/cro-analyze', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const bizArr = await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,marketing_goal,target_audience,website_url,brand_tone`);
    const biz = bizArr[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const prompt =
`You are a CRO expert. Analyze this business and generate 3 high-impact A/B tests.
Business: ${biz.business_name} | Industry: ${biz.industry}
Goal: ${biz.marketing_goal || 'generate leads'} | Audience: ${biz.target_audience || 'general consumers'}
Website: ${biz.website_url || 'not provided'} | Tone: ${biz.brand_tone || 'professional'}

Return ONLY a valid JSON array of 3 test objects:
[
  {
    "page": "homepage|pricing|contact|landing",
    "element": "headline|cta|hero_image|form|pricing",
    "variant_a": "current assumed version description",
    "variant_b": "challenger version to test",
    "hypothesis": "why variant B should win (1 sentence)",
    "expected_lift": "5-15%",
    "priority": "high|medium|low"
  }
]`;

    const tests = await callClaude(prompt, 'strategy', 1200);
    const testArr = Array.isArray(tests) ? tests : (tests.tests || []);

    // Save each test to ab_tests table
    const saved = [];
    for (const t of testArr.slice(0, 3)) {
      try {
        const row = await sbPost('ab_tests', {
          business_id,
          variant_a: t.variant_a || '',
          variant_b: t.variant_b || '',
          variant_c: JSON.stringify({ page: t.page, element: t.element, hypothesis: t.hypothesis, expected_lift: t.expected_lift, priority: t.priority })
        });
        saved.push({ ...t, id: row?.id });
      } catch { saved.push(t); }
    }

    res.json({ tests_created: saved.length, tests: saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/cro-generate-copy
// Generate 3 copy variations for a specific page element using brand voice.
// Body: { business_id, page_type, element_type, goal }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/cro-generate-copy', async (req, res) => {
  const { business_id, page_type, element_type, goal } = req.body;
  if (!business_id || !page_type || !element_type)
    return res.status(400).json({ error: 'business_id, page_type, element_type required' });
  try {
    const bizArr = await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal`);
    const biz = bizArr[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });

    // Retrieve brand voice context
    const brandContext = await getBrandExamples(business_id, 'social_post',
      `${biz.business_name} ${page_type} ${element_type}`);

    const prompt =
`${brandContext}Write 3 distinct variations of a ${element_type} for the ${page_type} page of ${biz.business_name} (${biz.industry}).
Goal: ${goal || biz.marketing_goal || 'convert visitors'} | Audience: ${biz.target_audience || 'general consumers'} | Tone: ${biz.brand_tone || 'professional'}
Each variation should use a different psychological angle (e.g. urgency, social proof, curiosity).
Return ONLY valid JSON: { "variations": [{ "text": "...", "rationale": "why this angle works" }] }`;

    const result = await callClaude(prompt, 'social_post', 800);
    const variations = result.variations || (Array.isArray(result) ? result : []);

    res.json({ variations, count: variations.length, page_type, element_type });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/video-script-generate
// Generate full structured video script + thumbnail. Saves to video_generations.
// Body: { business_id, platform, topic }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/video-script-generate', async (req, res) => {
  const { business_id, platform = 'tiktok', topic } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!['tiktok','instagram_reel','youtube_short'].includes(platform))
    return res.status(400).json({ error: 'platform must be tiktok|instagram_reel|youtube_short' });

  // Return 200 immediately — generation (~15s) in background
  res.json({ received: true, message: 'Video script generation started — check email in ~30 seconds' });

  setImmediate(async () => {
    try {
      const bizArr = await sbGet('businesses',
        `id=eq.${business_id}&select=business_name,industry,brand_tone,target_audience,marketing_goal,email,first_name`);
      const biz = bizArr[0];
      if (!biz) return;

      // Find topic from best performing content if not provided
      let useTopic = topic;
      if (!useTopic) {
        try {
          const latest = await sbGet('generated_content',
            `business_id=eq.${business_id}&status=eq.published&order=published_at.desc&limit=1&select=content_theme`);
          useTopic = latest[0]?.content_theme || `${biz.industry} tips for ${biz.target_audience || 'customers'}`;
        } catch { useTopic = `${biz.industry} tips`; }
      }

      // Brand voice context
      const brandContext = await getBrandExamples(business_id, 'social_post',
        `${biz.business_name} ${useTopic} video`);

      const platformLabel = { tiktok: 'TikTok', instagram_reel: 'Instagram Reel', youtube_short: 'YouTube Short' }[platform];

      const prompt =
`${brandContext}Write a ${platformLabel} video script for ${biz.business_name} (${biz.industry}).
Topic: "${useTopic}"
Tone: ${biz.brand_tone || 'energetic and authentic'} | Audience: ${biz.target_audience || 'general consumers'}

Return ONLY valid JSON:
{
  "scenes": [
    { "name": "hook",     "text": "...", "duration_sec": 3  },
    { "name": "problem",  "text": "...", "duration_sec": 7  },
    { "name": "solution", "text": "...", "duration_sec": 20 },
    { "name": "proof",    "text": "...", "duration_sec": 10 },
    { "name": "cta",      "text": "...", "duration_sec": 5  }
  ],
  "caption": "150 chars max, punchy",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7"],
  "thumbnail_text": "5 words max for overlay"
}`;

      const script = await callClaude(prompt, 'strategy', 1000);

      // Generate thumbnail via Flux → save to Supabase Storage
      let thumbnail_url = null;
      const thumbPrompt = `${script.thumbnail_text || useTopic} — ${biz.business_name}, vibrant ${platform} thumbnail, bold text overlay, 9:16 vertical`;
      try {
        const img = await generateImage(thumbPrompt, `${biz.industry} social media`);
        thumbnail_url = img?.url ? await saveImageToSupabase(img.url, business_id) : null;
      } catch {}

      // Save to video_generations
      const row = await sbPost('video_generations', {
        business_id, platform,
        script:       script,
        caption:      script.caption    || '',
        hashtags:     script.hashtags   || [],
        thumbnail_url,
        status:       'script_ready'
      });

      // Send email notification
      if (biz.email) {
        const html = `<h2>Your ${platformLabel} script is ready!</h2>
<p><strong>Topic:</strong> ${useTopic}</p>
<p><strong>Hook:</strong> "${(script.scenes || [])[0]?.text || ''}"</p>
<p><strong>Caption:</strong> ${script.caption || ''}</p>
${thumbnail_url ? `<img src="${thumbnail_url}" style="max-width:300px;border-radius:8px"><br>` : ''}
<p><a href="https://maroa-ai-marketing-automator.vercel.app/video" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View & Film</a></p>`;
        await sendEmail(biz.email, `Your ${platformLabel} script is ready: "${script.thumbnail_text || useTopic}"`, html).catch(() => {});
      }

      log('/webhook/video-script-generate',
        `✅ ${platform} script saved | id: ${row?.id} | topic: ${useTopic}`);
    } catch (err) {
      console.error('[video-script-generate ERROR]', err.message);
      await logError(business_id, 'video-script-generate', err.message, req.body).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/video-generate-runway
// Submit scenes to Runway Gen-3 Alpha for video generation.
// Body: { business_id, video_id }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/video-generate-runway', async (req, res) => {
  const { business_id, video_id } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });

  if (!RUNWAY_API_KEY)
    return res.json({ skipped: true, reason: 'RUNWAY_API_KEY not set — set it in Railway environment variables' });

  try {
    const rows = await sbGet('video_generations', `id=eq.${video_id}&select=*`);
    const vid  = rows[0];
    if (!vid) return res.status(404).json({ error: 'video not found' });

    const scenes  = (vid.script?.scenes || []).slice(0, 5);
    const taskIds = [];

    for (const scene of scenes) {
      try {
        const r = await apiRequest('POST', 'https://api.dev.runwayml.com/v1/image_to_video',
          { 'Authorization': `Bearer ${RUNWAY_API_KEY}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
          {
            promptText: `${scene.text} — cinematic, vertical 9:16 format, professional quality`,
            duration:   Math.min(scene.duration_sec || 4, 10),
            ratio:      '720:1280',
            ...(vid.thumbnail_url ? { promptImage: vid.thumbnail_url } : {})
          });
        if (r.body?.id) taskIds.push({ scene: scene.name, task_id: r.body.id });
      } catch (e) { log('/webhook/video-generate-runway', `scene "${scene.name}" error: ${e.message}`); }
    }

    await sbPatch('video_generations', `id=eq.${video_id}`, {
      runway_task_id: JSON.stringify(taskIds),
      status: taskIds.length ? 'generating' : 'failed'
    });

    res.json({ task_ids: taskIds, status: taskIds.length ? 'generating' : 'failed',
      check_back_in: '2 minutes', video_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/video-status?video_id=X
// Poll Runway task status; update DB when complete.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/video-status', async (req, res) => {
  const { video_id } = req.query;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  try {
    const rows = await sbGet('video_generations', `id=eq.${video_id}&select=*`);
    const vid  = rows[0];
    if (!vid) return res.status(404).json({ error: 'video not found' });

    // If no runway task or already done, return current state
    if (!vid.runway_task_id || vid.status === 'ready' || vid.status === 'published') {
      return res.json({ video_id, status: vid.status, video_url: vid.video_url, thumbnail_url: vid.thumbnail_url });
    }

    if (!RUNWAY_API_KEY)
      return res.json({ video_id, status: vid.status, note: 'RUNWAY_API_KEY not configured' });

    // Poll each task (handle single string or JSON array)
    let taskIds = [];
    try { taskIds = JSON.parse(vid.runway_task_id); } catch { taskIds = vid.runway_task_id ? [vid.runway_task_id] : []; }
    if (!Array.isArray(taskIds)) taskIds = [taskIds];
    const completedUrls = [];

    for (const t of taskIds) {
      try {
        const r = await apiRequest('GET', `https://api.dev.runwayml.com/v1/tasks/${t.task_id}`,
          { 'Authorization': `Bearer ${RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' });
        if (r.body?.status === 'SUCCEEDED' && r.body?.output?.[0]) {
          completedUrls.push({ scene: t.scene, url: r.body.output[0] });
        }
      } catch {}
    }

    const allDone = completedUrls.length === taskIds.length && taskIds.length > 0;
    if (allDone) {
      const videoUrl = completedUrls[0]?.url || null;
      await sbPatch('video_generations', `id=eq.${video_id}`,
        { video_url: videoUrl, status: 'ready' });
      return res.json({ video_id, status: 'ready', video_url: videoUrl, thumbnail_url: vid.thumbnail_url, scenes_ready: completedUrls });
    }

    res.json({ video_id, status: vid.status, completed_scenes: completedUrls.length,
      total_scenes: taskIds.length, check_back_in: '60 seconds' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhook/videos-get?business_id=X
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/videos-get', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const videos = await sbGet('video_generations',
      `business_id=eq.${business_id}&order=created_at.desc&limit=20`);

    // Add hook preview to each video
    const enriched = videos.map(v => ({
      ...v,
      hook_preview: v.script?.scenes?.[0]?.text || '',
      scene_count:  (v.script?.scenes || []).length
    }));

    const summary = {
      total:        videos.length,
      script_ready: videos.filter(v => v.status === 'script_ready').length,
      generating:   videos.filter(v => v.status === 'generating').length,
      ready:        videos.filter(v => v.status === 'ready').length,
      published:    videos.filter(v => v.status === 'published').length,
      by_platform:  videos.reduce((acc, v) => { acc[v.platform] = (acc[v.platform] || 0) + 1; return acc; }, {})
    };

    res.json({ videos: enriched, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  const validTypes = ['social_post','email','ad_copy','blog','video_script','competitor_intelligence'];
  if (!validTypes.includes(content_type))
    return res.status(400).json({ error: `content_type must be one of: ${validTypes.join('|')}` });

  if (performance_score < 7)
    return res.json({ stored: false, reason: 'performance_score below threshold (7)', performance_score });

  if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_HOST)
    return res.json({ stored: false, reason: 'Brand memory not configured — set OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST' });

  try {
    let vector;
    try { vector = await getEmbedding(text); }
    catch (embedErr) { return res.json({ stored: false, reason: `Embedding failed: ${embedErr.message.slice(0, 100)}` }); }
    const vector_id = `${business_id}-${Date.now()}`;
    await pineconeUpsert([{
      id: vector_id,
      values: vector,
      metadata: {
        businessId:       business_id,
        contentType:      content_type,
        performance_score,
        text:             text.slice(0, 500)
      }
    }]);
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
    try { vector = await getEmbedding(topic); }
    catch (embedErr) { return res.json({ examples: [], count: 0, reason: `Embedding failed: ${embedErr.message.slice(0, 100)}` }); }
    const result  = await pineconeQuery(
      vector,
      { businessId: { $eq: business_id }, contentType: { $eq: content_type } },
      3
    );
    const matches  = (result.matches || []).filter(m => m.score > 0.6 && m.metadata?.text);
    const examples = matches.map(m => m.metadata.text);
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
    return res.json({ trained_on: 0, stored: 0, reason: 'Brand memory not configured — set OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST' });

  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const pieces = await sbGet('generated_content',
      `business_id=eq.${business_id}&status=eq.published&published_at=gte.${since}&select=id,instagram_caption,facebook_post,email_body,blog_title,content_theme,performance_score,image_url`);

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
        { type: 'email',       text: p.email_body },
        { type: 'blog',        text: p.blog_title }
      ].filter(c => c.text && c.text.length > 20);

      for (const c of candidates) {
        try {
          // Call Pinecone directly — not via HTTP localhost
          const vector = await getEmbedding(c.text);
          const vectorId = `${business_id}-${p.id}-${c.type}`;
          await pineconeUpsert([{
            id: vectorId,
            values: vector,
            metadata: {
              businessId: business_id,
              contentType: c.type,
              performance_score: score,
              text: c.text.slice(0, 500),
              theme: p.content_theme || ''
            }
          }]);
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

  try {
    const updates = {};
    if (company_name)   updates.white_label_company_name  = company_name;
    if (primary_color)  updates.white_label_primary_color = primary_color;
    if (logo_url)       updates.white_label_logo_url      = logo_url;
    if (domain)         updates.white_label_domain        = domain;
    if (support_email)  updates.white_label_support_email = support_email;

    if (!Object.keys(updates).length)
      return res.status(400).json({ error: 'No white-label fields provided' });

    await sbPatch('organizations', `id=eq.${organization_id}`, updates);

    const orgs = await sbGet('organizations', `id=eq.${organization_id}&select=*`);
    const settings = orgs[0] || {};
    res.json({
      updated: true,
      settings: {
        company_name:   settings.white_label_company_name,
        primary_color:  settings.white_label_primary_color,
        logo_url:       settings.white_label_logo_url,
        domain:         settings.white_label_domain,
        support_email:  settings.white_label_support_email
      }
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
  try {
    const orgs = await sbGet('organizations',
      `id=eq.${organization_id}&select=white_label_company_name,white_label_primary_color,white_label_logo_url,white_label_domain,white_label_support_email,name`);
    const o = orgs[0];
    if (!o) return res.status(404).json({ error: 'organization not found' });
    res.json({
      company_name:   o.white_label_company_name  || o.name,
      primary_color:  o.white_label_primary_color || '#667eea',
      logo_url:       o.white_label_logo_url      || null,
      domain:         o.white_label_domain        || null,
      support_email:  o.white_label_support_email || 'hello@maroa.ai',
      is_white_labeled: !!(o.white_label_company_name || o.white_label_domain)
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
    const bizArr = await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,first_name,email,google_review_link`);
    const biz = bizArr[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const reviewLink = biz.google_review_link || 'https://g.page/r/review';

    const prompt =
`Write a friendly short email (under 80 words) asking ${contact_name || 'a valued customer'} to leave a Google review for ${biz.business_name}.
Owner name: ${biz.first_name || biz.business_name}. Review link: ${reviewLink}.
Be warm and genuine. Not pushy. Address them by first name.
Return ONLY valid JSON: { "subject": "...", "body_html": "..." }`;

    const email = await callClaude(prompt, 'social_post', 500);

    const subject  = email.subject  || `Quick favour — leave us a review?`;
    const bodyHtml = email.body_html || `<p>Hi ${contact_name || 'there'},</p><p>Would you mind leaving us a quick review? <a href="${reviewLink}">Click here</a>. Thanks so much!</p><p>${biz.first_name || biz.business_name}</p>`;

    // Send email
    await sendEmail(contact_email, subject, bodyHtml);

    // Log request
    const reqRow = await sbPost('review_requests', {
      business_id, contact_email, contact_name, platform, review_link: reviewLink
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
  if (!business_id || !review_id)
    return res.status(400).json({ error: 'business_id and review_id required' });
  if (!isUUID(review_id)) return res.status(400).json({ error: 'review_id must be a valid UUID' });

  try {
    const [bizArr, reviewArr] = await Promise.all([
      sbGet('businesses', `id=eq.${business_id}&select=business_name,first_name,email`),
      sbGet('reviews', `id=eq.${review_id}&select=*`)
    ]);
    const biz    = bizArr[0];
    const review = reviewArr[0];
    if (!biz)    return res.status(404).json({ error: 'business not found' });
    if (!review) return res.status(404).json({ error: 'review not found' });

    const stars = review.rating || 5;
    const tone  = stars >= 4 ? 'positive' : 'negative';

    const prompt =
`Write a professional response to this ${stars}-star review for ${biz.business_name}.
Review: "${review.review_text || 'No text provided'}"
Reviewer: ${review.reviewer_name || 'Valued customer'}

${tone === 'positive'
  ? `Thank warmly, mention a specific detail from their review, invite them back. Under 80 words.`
  : `Apologize sincerely, take accountability, offer to resolve offline with contact info. Under 100 words.`}
Sign as ${biz.first_name || 'The Team'} at ${biz.business_name}.
Return ONLY valid JSON: { "response_text": "..." }`;

    const result = await callClaude(prompt, 'social_post', 400);
    const response_text = result.response_text || result._raw || '';

    await sbPatch('reviews', `id=eq.${review_id}`,
      { response_draft: response_text, response_status: 'draft_ready' });

    // Notify business owner
    if (biz.email) {
      const html = `<h2>Review Response Draft Ready</h2>
<p><strong>Reviewer:</strong> ${review.reviewer_name || 'Anonymous'} — ${stars}⭐</p>
<p><strong>Review:</strong> "${review.review_text || ''}"</p>
<p><strong>Draft Response:</strong></p><blockquote>${response_text}</blockquote>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/reviews" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Publish</a></p>`;
      await sendEmail(biz.email, `Review response draft ready — ${stars}⭐ from ${review.reviewer_name || 'customer'}`, html).catch(() => {});
    }

    try { const praise = stars >= 4 ? (review.review_text || '').slice(0, 100) : ''; const complaint = stars <= 2 ? (review.review_text || '').slice(0, 100) : ''; if (praise) storeInsight(business_id, 'reviews', 'customer_voice', 'top_praise', praise); if (complaint) storeInsight(business_id, 'reviews', 'customer_voice', 'top_complaint', complaint); } catch {}
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
  if (!business_id || !review_id)
    return res.status(400).json({ error: 'business_id and review_id required' });
  if (!isUUID(review_id)) return res.status(400).json({ error: 'review_id must be a valid UUID' });

  try {
    const [bizArr, reviewArr] = await Promise.all([
      sbGet('businesses', `id=eq.${business_id}&select=business_name,google_business_id,google_access_token`),
      sbGet('reviews', `id=eq.${review_id}&select=*`)
    ]);
    const biz    = bizArr[0];
    const review = reviewArr[0];
    if (!biz)    return res.status(404).json({ error: 'business not found' });
    if (!review) return res.status(404).json({ error: 'review not found' });

    const responseText = review.response_draft || '';
    let published_via_api = false;

    // Attempt Google My Business API publish
    if (biz.google_business_id && biz.google_access_token && review.platform_review_id) {
      try {
        const gmbResp = await apiRequest('PUT',
          `https://mybusiness.googleapis.com/v4/accounts/${biz.google_business_id}/locations/-/reviews/${review.platform_review_id}/reply`,
          { 'Authorization': `Bearer ${biz.google_access_token}`, 'Content-Type': 'application/json' },
          { comment: responseText });
        if ([200, 201].includes(gmbResp.status)) published_via_api = true;
      } catch {}
    }

    await sbPatch('reviews', `id=eq.${review_id}`,
      { response_published: responseText, response_status: 'published' });

    res.json({ published: true, review_id, published_via_api,
      note: published_via_api ? 'Posted to Google My Business' : 'Marked published locally (GMB API not connected)' });
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
    if (status)   filter += `&response_status=eq.${status}`;
    if (platform) filter += `&platform=eq.${platform}`;

    const reviews = await sbGet('reviews', filter);

    const summary = {
      total:              reviews.length,
      pending_response:   reviews.filter(r => r.response_status === 'pending').length,
      draft_ready:        reviews.filter(r => r.response_status === 'draft_ready').length,
      published_response: reviews.filter(r => r.response_status === 'published').length,
      avg_rating:         reviews.length
        ? parseFloat((reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1)) : null,
      by_sentiment: {
        positive: reviews.filter(r => r.sentiment === 'positive').length,
        neutral:  reviews.filter(r => r.sentiment === 'neutral').length,
        negative: reviews.filter(r => r.sentiment === 'negative').length
      }
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
      total:      creatives.length,
      active:     creatives.filter(c => c.status === 'active').length,
      winners:    creatives.filter(c => c.is_winner).length,
      avg_ctr:    creatives.length
        ? (creatives.reduce((a, c) => a + parseFloat(c.ctr || 0), 0) / creatives.length).toFixed(3)
        : '0.000',
      platforms:  [...new Set(creatives.map(c => c.platform))]
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
  const { creative_id, status, is_winner, impressions, clicks, ctr } = req.body;
  if (!creative_id) return res.status(400).json({ error: 'creative_id required' });
  try {
    const updates = {};
    if (status     !== undefined) updates.status      = status;
    if (is_winner  !== undefined) updates.is_winner   = is_winner;
    if (impressions!== undefined) updates.impressions = impressions;
    if (clicks     !== undefined) updates.clicks      = clicks;
    if (ctr        !== undefined) updates.ctr         = ctr;

    if (!Object.keys(updates).length)
      return res.status(400).json({ error: 'No fields to update' });

    await sbPatch('ad_creatives', `id=eq.${creative_id}`, updates);

    // If this creative is being marked as winner, unmark siblings in same campaign
    if (is_winner === true) {
      const rows = await sbGet('ad_creatives', `id=eq.${creative_id}&select=campaign_id`);
      const cid = rows[0]?.campaign_id;
      if (cid) {
        await sbPatch('ad_creatives',
          `campaign_id=eq.${cid}&id=neq.${creative_id}`,
          { is_winner: false });
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
      sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal`).then(r => r[0]),
      sbGet('business_profiles', `user_id=eq.${business_id}&select=*`).catch(() => [])
    ]);
    if (!biz) return res.status(404).json({ error: 'business not found' });

    // Use master prompt if profile exists
    const adProfile = profileArr[0];
    let masterAdPrompt = '';
    if (adProfile?.physical_locations?.length > 0) {
      try {
        const { buildMasterPrompt: bmp, validateBeforeGeneration: vbg } = require('./services/masterPromptBuilder');
        const errors = vbg(adProfile, 'paid_ad');
        if (errors.length > 0) return res.status(400).json({ error: 'profile_incomplete', message: errors[0], all_errors: errors });
        masterAdPrompt = bmp(adProfile, 'paid_ad') + '\n\n';
      } catch {}
    }

    // Pull existing creatives to avoid repetition
    let existingFilter = `business_id=eq.${business_id}&platform=eq.${platform}&order=created_at.desc&limit=5&select=headline,primary_text`;
    const existing = await sbGet('ad_creatives', existingFilter);
    const existingHeadlines = existing.map(c => c.headline).filter(Boolean).join('; ');

    const prompt =
`${masterAdPrompt}You are a world-class Meta/Google ad copywriter. Create ${count} distinct ad creative variants for this business.

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
          headline:     v.headline     || '',
          primary_text: v.primary_text || '',
          description:  v.description  || '',
          cta:          v.cta          || 'LEARN_MORE',
          image_prompt: v.image_prompt || '',
          status:       'active'
        });
        saved.push({ ...v, id: row?.id });
      } catch { saved.push(v); }
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
    const tests = await sbGet('ab_tests',
      `business_id=eq.${business_id}&order=started_at.desc&limit=20`);

    const summary = {
      total:          tests.length,
      with_winner:    tests.filter(t => t.winner).length,
      without_winner: tests.filter(t => !t.winner).length
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
        sbGet('generated_content', `business_id=eq.${business_id}&order=created_at.desc&limit=10&select=content_theme,status,created_at`),
        sbGet('ad_campaigns', `business_id=eq.${business_id}&select=status,daily_budget,roas,clicks,impressions`),
        sbGet('competitor_insights', `business_id=eq.${business_id}&order=recorded_at.desc&limit=1`),
        sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=7`)
      ]);

      const biz  = bizArr[0];
      if (!biz) return;
      const comp = compArr[0] || {};

      const totalReach      = snapArr.reduce((s, r) => s + (r.reach || 0), 0);
      const totalClicks     = snapArr.reduce((s, r) => s + (r.clicks || 0), 0);
      const totalEngagement = snapArr.reduce((s, r) => s + (r.engagement || 0), 0);
      const activeCampaigns = campaignsArr.filter(c => c.status === 'active');
      const avgRoas         = activeCampaigns.length
        ? (activeCampaigns.reduce((s, c) => s + (c.roas || 0), 0) / activeCampaigns.length).toFixed(2)
        : '0';

      const prompt =
`You are the central AI brain for ${biz.business_name} (${biz.industry || 'general'}).

CURRENT STATE:
- Plan: ${biz.plan || 'free'}
- Total reach (7d): ${totalReach}
- Total clicks (7d): ${totalClicks}
- Total engagement (7d): ${totalEngagement}
- Active campaigns: ${activeCampaigns.length}
- Average ROAS: ${avgRoas}
- Content pieces (recent 10): ${contentArr.length}
- Content themes used: ${contentArr.map(c => c.content_theme).filter(Boolean).join(', ') || 'none'}

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

      const decisions = await callClaude(prompt, 'strategy', 1500);

      await sbPatch('businesses', `id=eq.${business_id}`, {
        ai_brain_decisions: JSON.stringify(decisions)
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
      retry_count: 0
    });
    if (business_id) setImmediate(() => alertOnRepeatedFailure(business_id, workflow_name || 'unknown').catch(() => {}));
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
      const [bizArr, contentArr, campaignsArr, compArr, snapArr, contactsArr, revenueArr, seqArr] = await Promise.all([
        sbGet('businesses', `id=eq.${business_id}&select=*`),
        sbGet('generated_content', `business_id=eq.${business_id}&order=created_at.desc&limit=20&select=id,content_theme,status,created_at,performance_score`),
        sbGet('ad_campaigns', `business_id=eq.${business_id}&select=id,status,daily_budget,roas,clicks,impressions,total_spend,campaign_type`),
        sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=1`),
        sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=14`),
        sbGet('contacts', `business_id=eq.${business_id}&select=id,lead_score,stage,intent_level&order=lead_score.desc&limit=50`),
        sbGet('revenue_attribution', `business_id=eq.${business_id}&order=attributed_at.desc&limit=10`).catch(() => []),
        sbGet('email_sequences', `business_id=eq.${business_id}&select=id,name,trigger_type,is_active`).catch(() => [])
      ]);

      const biz = bizArr[0];
      if (!biz) return;
      const comp = compArr[0] || {};

      // ── 2. Compute metrics ──────────────────────────────────────────────
      const week1 = snapArr.slice(0, 7);
      const week2 = snapArr.slice(7, 14);
      const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
      const thisWeek  = { reach: sum(week1,'reach'), clicks: sum(week1,'clicks'), engagement: sum(week1,'engagement') };
      const lastWeek  = { reach: sum(week2,'reach'), clicks: sum(week2,'clicks'), engagement: sum(week2,'engagement') };
      const activeCampaigns = campaignsArr.filter(c => c.status === 'active');
      const avgRoas = activeCampaigns.length
        ? (activeCampaigns.reduce((s,c) => s + (c.roas||0), 0) / activeCampaigns.length).toFixed(2) : '0';
      const totalSpend = campaignsArr.reduce((s,c) => s + (c.total_spend||0), 0);
      const totalRevenue = revenueArr.reduce((s,r) => s + (Number(r.amount)||0), 0);
      const hotLeads = contactsArr.filter(c => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
      const pendingContent = contentArr.filter(c => c.status === 'pending_approval').length;
      const topThemes = contentArr.filter(c => (c.performance_score||0) >= 7).map(c => c.content_theme).filter(Boolean);

      // ── 3. Claude Opus — full strategic decision ────────────────────────
      const prompt =
`You are the autonomous AI marketing agent for ${biz.business_name} (${biz.industry || 'general'}).
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

      const decisions = await callClaude(prompt, 'strategy', 2000);

      // ── 4. EXECUTE decisions automatically ──────────────────────────────
      const acts = decisions.actions || {};

      // 4a. Generate content if decided
      if (acts.generate_content) {
        try {
          await generateInstantContent(business_id);
          actions_taken.push('generated_content');
        } catch (e) { actions_taken.push(`content_error: ${e.message}`); }
      }

      // 4b. Pause low-ROAS campaigns
      if (Array.isArray(acts.pause_low_roas_campaigns)) {
        for (const cid of acts.pause_low_roas_campaigns) {
          if (isUUID(cid)) {
            try {
              await sbPatch('ad_campaigns', `id=eq.${cid}`, { status: 'paused', last_decision: 'AI Agent paused — low ROAS', last_optimized_at: new Date().toISOString() });
              actions_taken.push(`paused_campaign:${cid}`);
            } catch {}
          }
        }
      }

      // 4c. Increase budget on winning campaigns
      if (Array.isArray(acts.increase_budget_campaigns)) {
        for (const item of acts.increase_budget_campaigns) {
          if (item?.id && isUUID(item.id) && item.new_daily > 0) {
            try {
              await sbPatch('ad_campaigns', `id=eq.${item.id}`, { daily_budget: item.new_daily, last_decision: `AI Agent budget → $${item.new_daily}`, last_optimized_at: new Date().toISOString() });
              actions_taken.push(`budget_change:${item.id}→$${item.new_daily}`);
            } catch {}
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
<p><a href="https://maroa-ai-marketing-automator.vercel.app/dashboard" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Dashboard</a></p>`;
        await sendEmail(biz.email, `📈 ${biz.business_name} — AI Agent Win Alert`, html).catch(() => {});
        actions_taken.push('sent_win_alert');
      }

      // 4e. Send hot lead alert
      if (acts.send_lead_alert && hotLeads > 0 && biz.email) {
        const html = `<h2>🔥 Hot Lead Alert</h2><p>You have ${hotLeads} leads ready to buy. Check your CRM now!</p>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/crm" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Leads</a></p>`;
        await sendEmail(biz.email, `🔥 ${hotLeads} hot leads detected — ${biz.business_name}`, html).catch(() => {});
        actions_taken.push('sent_lead_alert');
      }

      // ── 5. Save decisions + log ─────────────────────────────────────────
      await sbPatch('businesses', `id=eq.${business_id}`, {
        ai_brain_decisions: JSON.stringify(decisions),
        strategy_updated_at: new Date().toISOString()
      });

      await sbPost('learning_logs', {
        business_id,
        decision_date: new Date().toISOString(),
        decision_data: JSON.stringify(decisions),
        actions_taken: JSON.stringify(actions_taken),
        performance_before: JSON.stringify({ thisWeek, lastWeek, avgRoas, hotLeads })
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
        sbGet('analytics_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=30&select=snapshot_date,engagement,reach,clicks,impressions`)
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      // If we have snapshots, ask Claude to analyze patterns
      const prompt =
`Analyze these daily analytics snapshots for ${biz.business_name} (${biz.industry || 'business'}) and determine the optimal posting schedule.

DATA (last 30 days):
${JSON.stringify(snapshots.map(s => ({ date: s.snapshot_date, engagement: s.engagement || 0, reach: s.reach || 0, clicks: s.clicks || 0 })))}

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
        optimal_posting_times: JSON.stringify(result)
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
        sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=2`)
      ]);
      const biz = bizArr[0];
      if (!biz || reports.length < 2) return log('/webhook/competitor-alert-check', 'Not enough reports to compare');

      const [latest, previous] = reports;

      const prompt =
`Compare these two competitor intelligence reports for ${biz.business_name} and detect significant changes.

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
        const changesList = (result.changes || []).map(c =>
          `<li><strong>[${c.severity}]</strong> ${c.description}<br/>→ ${c.recommended_action}</li>`
        ).join('');
        const html = `<h2>⚡ Competitor Alert — ${biz.business_name}</h2>
<p>${result.summary || 'Significant competitor changes detected.'}</p>
<ul>${changesList}</ul>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/competitors" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Full Report</a></p>`;
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
        sbGet('generated_content', `business_id=eq.${business_id}&order=created_at.desc&limit=20&select=content_theme,status,performance_score`),
        sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=1`)
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      const week1 = snapshots.slice(0, 7);
      const week2 = snapshots.slice(7, 14);
      const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
      const thisWeek = { reach: sum(week1,'reach'), clicks: sum(week1,'clicks'), engagement: sum(week1,'engagement') };
      const lastWeek = { reach: sum(week2,'reach'), clicks: sum(week2,'clicks'), engagement: sum(week2,'engagement') };

      const topContent = contentArr.filter(c => (c.performance_score||0) >= 7).map(c => c.content_theme).filter(Boolean);
      const lowContent = contentArr.filter(c => (c.performance_score||0) > 0 && (c.performance_score||0) < 4).map(c => c.content_theme).filter(Boolean);

      const prompt =
`You are the chief marketing strategist AI for ${biz.business_name} (${biz.industry || 'general'}).

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

      const result = await callClaude(prompt, 'strategy', 2000);

      const updates = { strategy_updated_at: new Date().toISOString() };
      if (result.marketing_strategy) updates.marketing_strategy = result.marketing_strategy;
      if (result.best_performing_themes) updates.best_performing_themes = JSON.stringify(result.best_performing_themes);
      if (result.worst_performing_themes) updates.worst_performing_themes = JSON.stringify(result.worst_performing_themes);
      if (result.weekly_forecast) updates.weekly_forecast = JSON.stringify(result.weekly_forecast);

      await sbPatch('businesses', `id=eq.${business_id}`, updates);

      // Log the strategy evolution
      await sbPost('learning_logs', {
        business_id,
        decision_date: new Date().toISOString(),
        decision_data: JSON.stringify(result),
        actions_taken: JSON.stringify(result.key_changes || []),
        performance_before: JSON.stringify({ thisWeek, lastWeek })
      }).catch(() => {});

      try { storeInsight(business_id, 'strategy', 'content_strategy', 'content_themes', (result.best_performing_themes || []).join(', ')); storeInsight(business_id, 'strategy', 'content_strategy', 'weekly_focus', result.marketing_strategy ? result.marketing_strategy.slice(0, 200) : ''); } catch {}
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
  if (!revenue_amount || isNaN(Number(revenue_amount))) return res.status(400).json({ error: 'revenue_amount required (number)' });
  if (!source) return res.status(400).json({ error: 'source required' });

  try {
    const row = await sbPost('revenue_attribution', {
      business_id,
      amount: Number(revenue_amount),
      source,
      campaign_id: campaign_id || null,
      content_id: content_id || null
    });

    // Recalculate total estimated revenue
    const allRevenue = await sbGet('revenue_attribution',
      `business_id=eq.${business_id}&select=amount`);
    const total = allRevenue.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    await sbPatch('businesses', `id=eq.${business_id}`, {
      estimated_revenue: total
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
    sbGet('generated_content', `business_id=eq.${businessId}&performance_score=gte.7&order=performance_score.desc&limit=5`).catch(() => []),
    sbGet('generated_content', `business_id=eq.${businessId}&performance_score=lte.3&performance_score=gt.0&limit=5`).catch(() => []),
    sbGet('businesses', `id=eq.${businessId}`)
  ]);
  const biz = bizArr[0] || {};
  return {
    what_worked: topContent.map(c => ({ theme: c.content_theme, score: c.performance_score, caption: (c.instagram_caption || '').slice(0,100) })),
    what_failed: failedContent.map(c => ({ theme: c.content_theme, score: c.performance_score })),
    business_profile: { name: biz.business_name, industry: biz.industry, goal: biz.marketing_goal, tone: biz.brand_tone, plan: biz.plan },
    past_decisions: learningLogs.map(l => { try { const d = typeof l.decision_data === 'string' ? JSON.parse(l.decision_data) : l.decision_data; return d?.learning; } catch { return null; } }).filter(Boolean).slice(0, 5),
    best_performing_themes: biz.best_performing_themes || '[]',
    worst_performing_themes: biz.worst_performing_themes || '[]',
    audience_insights: biz.audience_insights || biz.audience_insights_full || '{}'
  };
}

// ── Helper: perceiveEnvironment ───────────────────────────────────────────────
async function perceiveEnvironment(businessId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const [analytics, campaigns, leads, competitors, errors, pendingContent] = await Promise.all([
    sbGet('analytics_snapshots', `business_id=eq.${businessId}&snapshot_date=gte.${yesterday}`).catch(() => []),
    sbGet('ad_campaigns', `business_id=eq.${businessId}&status=eq.active`).catch(() => []),
    sbGet('contacts', `business_id=eq.${businessId}&lead_score=gte.50&order=lead_score.desc&limit=10`).catch(() => []),
    sbGet('competitor_reports', `business_id=eq.${businessId}&order=created_at.desc&limit=1`).catch(() => []),
    sbGet('errors', `business_id=eq.${businessId}&resolved=eq.false&order=created_at.desc&limit=5`).catch(() => []),
    sbGet('generated_content', `business_id=eq.${businessId}&status=eq.pending_approval`).catch(() => [])
  ]);
  return {
    todays_reach: analytics.reduce((s, a) => s + (a.reach || 0), 0),
    todays_engagement: analytics.reduce((s, a) => s + (a.engagement || 0), 0),
    active_campaigns: campaigns.length,
    total_ad_spend_today: campaigns.reduce((s, c) => s + (c.daily_budget || 0), 0),
    hot_leads: leads.length,
    top_lead_scores: leads.slice(0, 3).map(l => ({ score: l.lead_score, intent: l.intent_level })),
    competitor_latest: competitors[0]?.recommendation || 'No recent data',
    system_errors: errors.length,
    error_details: errors.slice(0, 2).map(e => e.error_message),
    content_awaiting_approval: pendingContent.length,
    timestamp: new Date().toISOString()
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
        apiRequest('POST', `${SELF}/webhook/instant-content`, { 'Content-Type': 'application/json' }, { business_id: businessId }).catch(() => {});
        actions.push({ action: 'content_generated', details: step.details || '' });
      } else if (act.includes('optimize') || act === 'optimize_campaign') {
        apiRequest('POST', `${SELF}/webhook/meta-campaign-optimize`, { 'Content-Type': 'application/json' }, { business_id: businessId }).catch(() => {});
        actions.push({ action: 'campaigns_optimized' });
      } else if (act.includes('competitor') || act === 'analyze_competitors') {
        apiRequest('POST', `${SELF}/webhook/competitor-analyze`, { 'Content-Type': 'application/json' }, { business_id: businessId }).catch(() => {});
        actions.push({ action: 'competitor_analysis_triggered' });
      } else if (act.includes('lead') || act.includes('followup') || act === 'send_lead_followup') {
        apiRequest('POST', `${SELF}/webhook/email-sequence-process`, { 'Content-Type': 'application/json' }, {}).catch(() => {});
        actions.push({ action: 'lead_followup_triggered' });
      } else if (act.includes('seo')) {
        apiRequest('POST', `${SELF}/webhook/seo-audit`, { 'Content-Type': 'application/json' }, { business_id: businessId }).catch(() => {});
        actions.push({ action: 'seo_audit_triggered' });
      } else {
        actions.push({ action: act, details: step.details || '', status: 'noted' });
      }
    } catch (err) { console.error('[executePlan] Step failed:', step.action, err.message); }
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
    performance_before: JSON.stringify(currentState)
  }).catch(() => {});

  if (learning?.pattern_detected) {
    try {
      const bizArr = await sbGet('businesses', `id=eq.${businessId}&select=audience_insights`);
      const existing = (() => { try { return JSON.parse(bizArr[0]?.audience_insights || '{}'); } catch { return {}; } })();
      await sbPatch('businesses', `id=eq.${businessId}`, {
        audience_insights: JSON.stringify({ ...existing, latest_pattern: learning.pattern_detected, updated_at: new Date().toISOString() })
      });
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL 1: POST /webhook/master-agent  — SELF-IMPROVING AI BRAIN
// Full reasoning loop: Memory → Perception → Reasoning → Execution → Learning
// ─────────────────────────────────────────────────────────────────────────────
async function masterAgent(businessId) {
  const memory       = await getBusinessMemory(businessId);
  const currentState = await perceiveEnvironment(businessId);

  const prompt =
`You are the autonomous marketing brain for ${memory.business_profile.name || 'this business'} (${memory.business_profile.industry || 'general'}).

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

  const plan = await callClaude(prompt, 'strategy', 4000);

  // EXECUTION
  const actions = await executePlan(businessId, plan.execution_plan);

  // LEARNING
  await updateBusinessMemory(businessId, plan.learning, currentState);

  // DASHBOARD UPDATE
  await sbPatch('businesses', `id=eq.${businessId}`, {
    ai_brain_decisions: JSON.stringify(plan),
    strategy_updated_at: new Date().toISOString()
  }).catch(() => {});

  // Save full session
  await sbPost('learning_logs', {
    business_id: businessId,
    decision_date: new Date().toISOString(),
    decision_data: JSON.stringify(plan),
    actions_taken: JSON.stringify(actions),
    performance_before: JSON.stringify(currentState)
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
      log('/webhook/master-agent', `✅ Complete. Score: ${result.diagnosis?.score} Action: ${result.highest_leverage_action?.what}`);
    } catch (err) {
      console.error('[master-agent] Fatal error:', err.message);
      await logError(business_id, 'master-agent', err.message).catch(() => {});
    }
  });
});

app.post('/webhook/master-agent-all', async (req, res) => {
  res.json({ received: true, message: 'Running master agent for all active businesses' });
  setImmediate(async () => {
    try {
      const businesses = await sbGet('businesses', 'is_active=eq.true&select=id');
      log('/webhook/master-agent-all', `Running for ${businesses.length} businesses`);
      for (const biz of businesses) {
        try { await masterAgent(biz.id); } catch (e) { console.error(`[master-agent-all] ${biz.id} error:`, e.message); }
        await new Promise(r => setTimeout(r, 10000));
      }
    } catch (err) { console.error('[master-agent-all]', err.message); }
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
      sbGet('generated_content', `business_id=eq.${business_id}&published_at=lt.${cutoff}&performance_score=eq.0&status=eq.published&limit=20`)
    ]);
    const biz = bizArr[0];
    if (!biz?.meta_access_token || !biz?.facebook_page_id) return res.json({ measured: 0, reason: 'Meta not connected' });

    let measured = 0, high = 0, low = 0;
    // Fetch recent page posts
    const postsResp = await apiRequest('GET',
      `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/posts?fields=id,message,created_time,insights.metric(post_impressions,post_engaged_users)&limit=20&access_token=${biz.meta_access_token}`, {});
    const fbPosts = postsResp.body?.data || [];

    for (const content of unmeasured) {
      // Try to match a FB post to this content by time proximity
      const pubTime = new Date(content.published_at).getTime();
      const match = fbPosts.find(p => Math.abs(new Date(p.created_time).getTime() - pubTime) < 12 * 60 * 60 * 1000);
      if (!match) continue;

      const metrics = match.insights?.data || [];
      const impressions = metrics.find(m => m.name === 'post_impressions')?.values?.[0]?.value || 0;
      const engaged     = metrics.find(m => m.name === 'post_engaged_users')?.values?.[0]?.value || 0;
      const perfScore   = impressions > 0 ? Math.min(10, Math.round((engaged / impressions) * 100)) : 0;

      await sbPatch('generated_content', `id=eq.${content.id}`, { performance_score: perfScore, total_reach: impressions, facebook_post_id: match.id });
      measured++;

      if (perfScore >= 7) {
        high++;
        // Store in brand memory
        try {
          if (OPENAI_API_KEY && PINECONE_API_KEY && PINECONE_HOST) {
            const text = content.instagram_caption || content.facebook_post || '';
            if (text) {
              const vector = await getEmbedding(text);
              await pineconeUpsert([{ id: content.id, values: vector, metadata: { businessId: business_id, contentType: 'social_post', text: text.slice(0, 1000), score: perfScore } }]);
            }
          }
        } catch {}
      } else if (perfScore <= 2) {
        low++;
        await sbPost('learning_logs', { business_id, decision_date: new Date().toISOString(), decision_data: JSON.stringify({ learning: { avoid_this: content.content_theme, score: perfScore } }), performance_before: JSON.stringify({ impressions, engaged }) }).catch(() => {});
      }
    }

    res.json({ measured, high_performers: high, low_performers: low, total_checked: unmeasured.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL 3: POST /webhook/score-content-before-posting
// Predictive scoring — Claude rates content before it goes live.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/score-content-before-posting', async (req, res) => {
  const { business_id, caption, image_url } = req.body;
  if (!business_id || !caption) return res.status(400).json({ error: 'business_id and caption required' });

  try {
    const bizArr = await sbGet('businesses', `id=eq.${business_id}&select=business_name,brand_tone,target_audience,best_performing_themes`);
    const biz = bizArr[0] || {};
    const brandExamples = await getBrandExamples(business_id, 'social_post', caption.slice(0, 200));
    const recentContent = await sbGet('generated_content', `business_id=eq.${business_id}&order=created_at.desc&limit=5&select=instagram_caption,content_theme`);

    const prompt =
`${brandExamples}Rate this content BEFORE posting on a 1-10 scale.

BUSINESS: ${biz.business_name || 'Business'} | TONE: ${biz.brand_tone || 'professional'} | AUDIENCE: ${biz.target_audience || 'general'}
BEST THEMES: ${biz.best_performing_themes || 'unknown'}
RECENT POSTS (to check uniqueness): ${recentContent.map(c => (c.instagram_caption || '').slice(0, 80)).join(' | ')}

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
      const improvePrompt =
`Rewrite this social media caption to be MUCH better. Apply this feedback: "${result.improvement}"
Original: "${caption}"
Brand tone: ${biz.brand_tone || 'professional'} | Audience: ${biz.target_audience || 'general'}
Return ONLY valid JSON: {"improved_caption": "the rewritten caption"}`;
      const improved = await callClaude(improvePrompt, 'social_post', 500);
      improved_caption = improved.improved_caption || null;
    }

    res.json({ score: result.total_score, breakdown: result.breakdown, recommendation: result.recommendation, improvement: result.improvement, improved_caption, reasoning: result.reasoning });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        sbGet('analytics_snapshots', `business_id=eq.${business_id}&snapshot_date=gte.${ninetyAgo}&order=snapshot_date.asc`),
        sbGet('generated_content', `business_id=eq.${business_id}&performance_score=gt.0&order=performance_score.desc&limit=30&select=content_theme,performance_score,created_at,status`)
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      // Group snapshots by day of week
      const byDay = {};
      for (const s of snapshots) {
        const day = new Date(s.snapshot_date).toLocaleDateString('en-US', { weekday: 'long' });
        if (!byDay[day]) byDay[day] = { engagement: 0, reach: 0, count: 0 };
        byDay[day].engagement += (s.engagement || 0);
        byDay[day].reach += (s.reach || 0);
        byDay[day].count++;
      }
      const dayAvgs = Object.entries(byDay).map(([day, d]) => ({ day, avg_engagement: d.count > 0 ? (d.engagement / d.count).toFixed(1) : 0, avg_reach: d.count > 0 ? (d.reach / d.count).toFixed(1) : 0 })).sort((a, b) => b.avg_engagement - a.avg_engagement);

      // Content performance by theme
      const byTheme = {};
      for (const c of contentArr) {
        const t = c.content_theme || 'unknown';
        if (!byTheme[t]) byTheme[t] = { total_score: 0, count: 0 };
        byTheme[t].total_score += (c.performance_score || 0);
        byTheme[t].count++;
      }
      const themeScores = Object.entries(byTheme).map(([theme, d]) => ({ theme, avg_score: (d.total_score / d.count).toFixed(1), count: d.count })).sort((a, b) => b.avg_score - a.avg_score);

      // Growth rate (week over week reach)
      const weeks = [];
      for (let i = 0; i < snapshots.length; i += 7) {
        const weekSlice = snapshots.slice(i, i + 7);
        weeks.push(weekSlice.reduce((s, r) => s + (r.reach || 0), 0));
      }
      const growthRates = weeks.slice(1).map((w, i) => weeks[i] > 0 ? ((w - weeks[i]) / weeks[i] * 100).toFixed(1) + '%' : 'N/A');

      const prompt =
`Based on 90 days of data for ${biz.business_name} (${biz.industry || 'business'}), describe the audience in detail.

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

      const result = await callClaude(prompt, 'strategy', 1500);

      await sbPatch('businesses', `id=eq.${business_id}`, {
        audience_insights_full: JSON.stringify(result),
        optimal_posting_times: JSON.stringify(result.optimal_posting_times || []),
        best_performing_themes: JSON.stringify(result.best_content_types || []),
        worst_performing_themes: JSON.stringify(result.worst_content_types || [])
      });

      try { storeInsight(business_id, 'audience', 'audience_intelligence', 'best_day', result.best_day_to_post || ''); storeInsight(business_id, 'audience', 'audience_intelligence', 'growth_trajectory', result.growth_trajectory || ''); storeInsight(business_id, 'audience', 'audience_intelligence', 'key_insight', result.key_insight || ''); } catch {}
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
        sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,target_audience,best_performing_themes,brand_tone`),
        sbGet('competitor_reports', `business_id=eq.${business_id}&order=created_at.desc&limit=3`),
        sbGet('generated_content', `business_id=eq.${business_id}&performance_score=gte.6&order=performance_score.desc&limit=10&select=content_theme,instagram_caption,performance_score`)
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      const compThemes = compReports.flatMap(r => r.content_themes || []);
      const ourThemes  = topContent.map(c => c.content_theme).filter(Boolean);

      const prompt =
`You are a competitive strategist for ${biz.business_name} (${biz.industry || 'business'}).

COMPETITOR CONTENT THEMES (what they cover): ${JSON.stringify([...new Set(compThemes)])}
COMPETITOR RECOMMENDATIONS: ${compReports.map(r => r.recommendation).filter(Boolean).join(' | ')}

OUR TOP PERFORMING THEMES: ${JSON.stringify([...new Set(ourThemes)])}
OUR BEST CONTENT: ${topContent.slice(0, 3).map(c => `"${(c.instagram_caption || '').slice(0, 100)}..." (score: ${c.performance_score})`).join('\n')}

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

      const result = await callClaude(prompt, 'strategy', 1500);

      await sbPatch('businesses', `id=eq.${business_id}`, {
        content_opportunities: JSON.stringify(result.content_opportunities || []),
        competitive_moat: JSON.stringify(result)
      });

      try { storeInsight(business_id, 'moat', 'competitive_intelligence', 'moat_strategy', result.moat_strategy || ''); storeInsight(business_id, 'moat', 'competitive_intelligence', 'content_gaps', (result.content_opportunities || []).slice(0, 3).map(o => o.topic || o).join('; ')); } catch {}
      log('/webhook/build-competitive-moat', `✅ Moat built for ${biz.business_name}: ${(result.content_opportunities || []).length} opportunities`);
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
      const bizArr = await sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal,best_performing_themes`);
      const biz = bizArr[0];
      if (!biz) return;

      const prompt =
`Design a complete multi-channel marketing campaign for ${biz.business_name} (${biz.industry || 'business'}).

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

      const campaign = await callClaude(prompt, 'strategy', 3000);

      // Save orchestration
      const orchRow = await sbPost('campaign_orchestrations', {
        business_id,
        campaign_name: campaign.campaign_name || 'AI Campaign',
        campaign_theme: campaign.campaign_theme || '',
        campaign_plan: JSON.stringify(campaign),
        status: 'active',
        start_date: new Date().toISOString(),
        end_date: new Date(Date.now() + duration_days * 86400000).toISOString()
      }).catch(() => null);

      // Execute: generate first batch of content
      const SELF = 'https://maroa-api-production.up.railway.app';
      apiRequest('POST', `${SELF}/webhook/instant-content`, { 'Content-Type': 'application/json' }, { business_id }).catch(() => {});

      // Execute: create email sequence if specified
      if (campaign.channels?.email) {
        const emails = [];
        for (let i = 0; i < (campaign.channels.email.emails || 3); i++) {
          emails.push({ subject_prompt: `Email ${i + 1} for ${campaign.campaign_name}`, body_prompt: `${campaign.campaign_theme} - email ${i + 1}`, delay_hours: i * 48 });
        }
        apiRequest('POST', `${SELF}/webhook/email-sequence-create`, { 'Content-Type': 'application/json' }, { business_id, name: campaign.channels.email.sequence_name || campaign.campaign_name, trigger_type: campaign.channels.email.trigger || 'signup', emails }).catch(() => {});
      }

      log('/webhook/orchestrate-campaign', `✅ Campaign "${campaign.campaign_name}" orchestrated for ${biz.business_name}`);
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
        sbGet('reviews', `business_id=eq.${business_id}&order=created_at.desc&limit=10`).catch(() => [])
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
      const thisReach = sum(thisWeekSnaps, 'reach');
      const lastReach = sum(lastWeekSnaps, 'reach');
      const reachDrop = lastReach > 0 ? ((thisReach - lastReach) / lastReach * 100) : 0;
      const negativeReviews = reviews.filter(r => (r.rating || 5) <= 2).length;
      const wastedSpend = campaigns.filter(c => (c.total_spend || 0) > 20 && (c.conversions || 0) === 0);

      const signals = [];
      if (reachDrop < -50) signals.push({ type: 'reach_collapse', detail: `Reach dropped ${reachDrop.toFixed(0)}% vs last week` });
      if (negativeReviews >= 3) signals.push({ type: 'negative_sentiment', detail: `${negativeReviews} negative reviews recently` });
      if (errors.length >= 5) signals.push({ type: 'high_error_rate', detail: `${errors.length} unresolved system errors` });
      if (wastedSpend.length > 0) signals.push({ type: 'wasted_spend', detail: `${wastedSpend.length} campaigns spending with 0 conversions` });

      if (!signals.length) {
        await sbPatch('businesses', `id=eq.${business_id}`, { crisis_status: 'healthy' });
        return log('/webhook/crisis-check', `${biz.business_name}: all healthy`);
      }

      // CRISIS DETECTED — Claude Opus responds
      const prompt =
`CRISIS DETECTED for ${biz.business_name}.

SIGNALS:
${signals.map(s => `- [${s.type}] ${s.detail}`).join('\n')}

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

      const response = await callClaude(prompt, 'strategy', 1500);

      await sbPatch('businesses', `id=eq.${business_id}`, { crisis_status: response.crisis_level || 'warning' });

      // Pause campaigns if recommended
      if (Array.isArray(response.campaigns_to_pause)) {
        for (const wc of wastedSpend) {
          await sbPatch('ad_campaigns', `id=eq.${wc.id}`, { status: 'paused', paused_reason: 'Crisis auto-pause: wasted spend' }).catch(() => {});
        }
      }

      // Send alert email
      if (biz.email) {
        const html = `<h2>⚠️ Marketing Crisis Detected — ${biz.business_name}</h2>
<p><strong>Level:</strong> ${(response.crisis_level || 'warning').toUpperCase()}</p>
<p><strong>Diagnosis:</strong> ${response.diagnosis || ''}</p>
<p><strong>Immediate action:</strong> ${response.immediate_action || ''}</p>
<h3>Recovery Plan:</h3>
<ul>${(response.recovery_plan || []).map(s => `<li><strong>${s.timeframe}:</strong> ${s.action}</li>`).join('')}</ul>
<p><a href="https://maroa-ai-marketing-automator.vercel.app/dashboard" style="background:#e53e3e;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View Dashboard</a></p>`;
        await sendEmail(biz.email, `⚠️ CRISIS: ${response.crisis_level} — ${biz.business_name}`, html).catch(() => {});
      }

      // Emergency content if needed
      if (response.emergency_content_needed) {
        apiRequest('POST', 'https://maroa-api-production.up.railway.app/webhook/instant-content', { 'Content-Type': 'application/json' }, { business_id }).catch(() => {});
      }

      log('/webhook/crisis-check', `⚠️ CRISIS ${response.crisis_level} for ${biz.business_name}: ${response.diagnosis}`);
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
        sbGet('generated_content', `business_id=eq.${business_id}&order=created_at.desc&limit=10&select=status,performance_score`)
      ]);
      const biz = bizArr[0];
      if (!biz) return;

      const totalReach   = snapshots.reduce((s,r) => s + (r.reach||0), 0);
      const totalRevenue = revenue.reduce((s,r) => s + (Number(r.amount)||0), 0);
      const activeCamps  = campaigns.filter(c => c.status === 'active').length;
      const hotLeads     = contacts.filter(c => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
      const avgContent   = content.length > 0 ? (content.reduce((s,c) => s + (c.performance_score||0), 0) / content.length).toFixed(1) : '0';

      const prompt =
`You are a growth strategist for ${biz.business_name} (${biz.industry || 'business'}).
Plan: ${biz.plan || 'free'} | Goal: ${biz.marketing_goal || 'grow'}

CURRENT METRICS (30 days):
- Total reach: ${totalReach} | Revenue: $${totalRevenue.toFixed(2)}
- Active campaigns: ${activeCamps} | Hot leads: ${hotLeads}
- Total contacts: ${contacts.length} | Avg content score: ${avgContent}/10
- Ad spend: $${campaigns.reduce((s,c) => s + (c.total_spend||0), 0).toFixed(2)}

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

      const result = await callClaude(prompt, 'strategy', 2000);

      await sbPatch('businesses', `id=eq.${business_id}`, {
        growth_engine_recommendation: JSON.stringify(result),
        ai_brain_decisions: JSON.stringify({ ...((() => { try { return JSON.parse(biz.ai_brain_decisions || '{}'); } catch { return {}; } })()), growth_engine: result.recommended_action }),
        strategy_updated_at: new Date().toISOString()
      });

      try { storeInsight(business_id, 'growth', 'growth_strategy', 'top_lever', result.recommended_action?.lever || ''); storeInsight(business_id, 'growth', 'growth_strategy', 'bottleneck', result.bottleneck || ''); } catch {}
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
      sbGet('businesses', `id=eq.${business_id}&select=business_name,email,facebook_page_id,meta_access_token,instagram_account_id,linkedin_access_token,autopilot_enabled`),
      sbGet('generated_content', `business_id=eq.${business_id}&status=eq.pending_approval&order=created_at.desc&limit=50&select=id,instagram_caption,facebook_post,content_theme,strategy_reason`)
    ]);
    const biz = bizArr[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });
    if (!pending.length) return res.json({ approved: 0, sent_for_review: 0, regenerated: 0, message: 'No pending content' });

    let approved = 0, sent_for_review = 0, regenerated = 0;

    for (const piece of pending) {
      try {
        const caption = piece.instagram_caption || piece.facebook_post || '';
        if (!caption) { regenerated++; continue; }

        // Score internally via callClaude (faster than HTTP round-trip)
        const scorePrompt = `Rate this social media caption 1-10 for a ${biz.business_name || 'business'}. Consider brand voice, engagement potential, uniqueness, audience relevance. Caption: "${caption.slice(0, 500)}" Return ONLY valid JSON: {"score":1-10}`;
        const scoreResult = await callClaude(scorePrompt, 'caption', 200);
        const score = scoreResult.score || 0;

        if (score >= 7) {
          await sbPatch('generated_content', `id=eq.${piece.id}`, {
            status: 'approved', approved_at: new Date().toISOString(),
            approval_method: 'auto_ai', pre_post_score: score
          });
          approved++;
        } else if (score >= 5) {
          // Send for human review
          if (biz.email) {
            await sendEmail(biz.email,
              `Content needs your review — ${piece.content_theme || 'new post'}`,
              `<h2>Quick Review Needed</h2><p>AI scored this <strong>${score}/10</strong>:</p><blockquote>${caption.slice(0, 300)}</blockquote><p><a href="https://maroa-ai-marketing-automator.vercel.app/content" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve</a></p>`
            ).catch(() => {});
          }
          sent_for_review++;
        } else {
          // Auto-regenerate
          await sbPatch('generated_content', `id=eq.${piece.id}`, { status: 'rejected' });
          regenerated++;
        }
      } catch (e) { log('/webhook/auto-approve-content', `Piece ${piece.id} error: ${e.message}`); }
    }

    // Trigger regeneration if any were rejected
    if (regenerated > 0) {
      apiRequest('POST', 'https://maroa-api-production.up.railway.app/webhook/instant-content',
        { 'Content-Type': 'application/json' },
        { business_id, email: biz.email }).catch(() => {});
    }

    res.json({ approved, sent_for_review, regenerated, total: pending.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      sbGet('businesses', `id=eq.${business_id}&select=business_name,meta_access_token,facebook_page_id,instagram_account_id,linkedin_access_token,linkedin_person_id,autopilot_enabled,posts_published`),
      sbGet('generated_content', `business_id=eq.${business_id}&status=eq.approved&published_at=is.null&order=created_at.asc&limit=10&select=id,instagram_caption,facebook_post,image_url,content_theme,strategy_reason`)
    ]);
    const biz = bizArr[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });
    if (!approved.length) return res.json({ published: 0, failed: 0, platforms: [], message: 'No approved content to publish' });

    let published = 0, failed = 0;
    const allPlatforms = new Set();

    for (const piece of approved) {
      const platforms = [];
      try {
        // Facebook
        if (biz.meta_access_token && biz.facebook_page_id) {
          try {
            const fbResp = await apiRequest('POST',
              `https://graph.facebook.com/v19.0/${biz.facebook_page_id}/feed`,
              { 'Content-Type': 'application/json' },
              { message: piece.facebook_post || piece.instagram_caption, access_token: biz.meta_access_token, ...(piece.image_url ? { link: piece.image_url } : {}) });
            if (fbResp.body?.id) platforms.push('facebook');
          } catch {}
        }

        // Instagram
        if (biz.meta_access_token && biz.instagram_account_id && piece.image_url) {
          try {
            const step1 = await apiRequest('POST',
              `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media`,
              { 'Content-Type': 'application/json' },
              { image_url: piece.image_url, caption: piece.instagram_caption, access_token: biz.meta_access_token });
            if (step1.body?.id) {
              const step2 = await apiRequest('POST',
                `https://graph.facebook.com/v19.0/${biz.instagram_account_id}/media_publish`,
                { 'Content-Type': 'application/json' },
                { creation_id: step1.body.id, access_token: biz.meta_access_token });
              if (step2.body?.id) platforms.push('instagram');
            }
          } catch {}
        }

        // LinkedIn
        if (biz.linkedin_access_token && biz.linkedin_person_id) {
          try {
            const authorUrn = `urn:li:person:${biz.linkedin_person_id}`;
            const ugc = { author: authorUrn, lifecycleState: 'PUBLISHED',
              specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: piece.instagram_caption || piece.facebook_post }, shareMediaCategory: 'NONE' } },
              visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } };
            const liResp = await apiRequest('POST', 'https://api.linkedin.com/v2/ugcPosts',
              { 'Authorization': `Bearer ${biz.linkedin_access_token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' }, ugc);
            if (liResp.body?.id) platforms.push('linkedin');
          } catch {}
        }

        if (platforms.length > 0) {
          await sbPatch('generated_content', `id=eq.${piece.id}`, { status: 'published', published_at: new Date().toISOString() });
          platforms.forEach(p => allPlatforms.add(p));
          published++;
        } else {
          failed++;
        }
      } catch { failed++; }
    }

    // Update posts_published count
    if (published > 0) {
      await sbPatch('businesses', `id=eq.${business_id}`, { posts_published: (biz.posts_published || 0) + published }).catch(() => {});
    }

    res.json({ published, failed, platforms: [...allPlatforms], total: approved.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhook/generate-image — On-demand image generation API
// Body: { business_id, prompt, content_type? }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/generate-image', async (req, res) => {
  const { business_id, prompt, content_type = 'social_post' } = req.body;
  if (!business_id || !prompt) return res.status(400).json({ error: 'business_id and prompt required' });

  // Return immediately — generation happens async (Flux can take 30-60s)
  res.json({ received: true, message: 'Image generation started — result saved to business_photos' });

  setImmediate(async () => {
    try {
      const bizArr = await sbGet('businesses', `id=eq.${business_id}&select=plan`);
      const plan = bizArr[0]?.plan || 'free';
      const result = await generateSmartImage(business_id, prompt, content_type, plan);
      if (result.url) {
        await sbPost('business_photos', {
          business_id, photo_url: result.url, photo_type: content_type,
          description: prompt.slice(0, 200), is_active: true
        }).catch(() => {});
        try { storeInsight(business_id, 'images', 'visual_strategy', 'image_model', result.model_used || 'unknown'); } catch {}
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
    const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'
    }, {
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: image_url } },
        { type: 'text', text: `Score this marketing image for a ${content_type} post. Rate 1-10 on: professional quality, visual appeal, marketing effectiveness. Return ONLY valid JSON: {"overall_score":1-10,"recommendation":"use"|"regenerate"|"reject","feedback":"one sentence"}` }
      ] }]
    });
    if (r.status !== 200) return res.status(502).json({ overall_score: 5, recommendation: 'use', feedback: 'Could not score image — using fallback' });
    const raw = r.body?.content?.[0]?.text || '';
    const parsed = extractJSON(raw) || { overall_score: 5, recommendation: 'use', feedback: 'Could not parse score' };
    res.json(parsed);
  } catch (err) { res.status(500).json({ overall_score: 5, recommendation: 'use', feedback: 'Image scoring failed' }); }
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
  } catch (err) { res.status(500).json({ error: 'Failed to fetch errors' }); }
});

// FINAL COMPLETE PLATFORM — Missing Pieces 2-15
// ═════════════════════════════════════════════════════════════════════════════

// ── PIECE 2: WhatsApp Notifications ─────────────────────────────────────────
app.post('/webhook/whatsapp-send', async (req, res) => {
  const { business_id, message } = req.body;
  if (!business_id || !message) return res.status(400).json({ error: 'business_id and message required' });
  try {
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=whatsapp_number,whatsapp_enabled,business_name`))[0];
    if (!biz?.whatsapp_number || !biz.whatsapp_enabled) return res.json({ sent: false, reason: 'WhatsApp not configured' });
    const result = await sendWhatsApp(biz.whatsapp_number, message);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/whatsapp-test', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=whatsapp_number,whatsapp_enabled,business_name`))[0];
    if (!biz?.whatsapp_number) return res.json({ sent: false, reason: 'No whatsapp_number set — add it in Settings' });
    if (!TWILIO_ACCOUNT_SID) return res.json({ sent: false, reason: 'Twilio not configured — set TWILIO_ACCOUNT_SID in Railway' });
    const msg = `✅ *maroa.ai WhatsApp Connected!*\n\nHi! This is your AI marketing assistant for ${biz.business_name}.\n\nYou'll receive:\n📊 Weekly performance digests\n🔥 Hot lead alerts\n🚀 Viral content notifications\n⚡ Competitor alerts\n\nYour AI is always working. 🤖`;
    const result = await sendWhatsApp(biz.whatsapp_number, msg);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/whatsapp-weekly-digest', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Weekly digest being sent' });
  setImmediate(async () => {
    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=business_name,whatsapp_number,whatsapp_enabled,ai_brain_decisions,posts_published`))[0];
      if (!biz?.whatsapp_number || !biz.whatsapp_enabled) return;
      const weekAgo = new Date(Date.now() - 7*86400000).toISOString();
      const [contacts, content] = await Promise.all([
        sbGet('contacts', `business_id=eq.${business_id}&created_at=gte.${weekAgo}&select=id`),
        sbGet('generated_content', `business_id=eq.${business_id}&created_at=gte.${weekAgo}&status=eq.published&select=content_theme,performance_score`)
      ]);
      const bestTheme = content.sort((a,b) => (b.performance_score||0)-(a.performance_score||0))[0]?.content_theme || 'various topics';
      let brain = {}; try { brain = JSON.parse(biz.ai_brain_decisions || '{}'); } catch {}
      const msg = `📊 *Your AI Marketing Week — ${biz.business_name}*\n\n✅ Posts published: ${content.length}\n👥 New leads: ${contacts.length}\n🎯 Best post: ${bestTheme}\n💡 Focus: ${brain.content_strategy || brain.highest_leverage_action?.what || 'growing your brand'}\n\nYour AI is running. Nothing to do. 🤖`;
      await sendWhatsApp(biz.whatsapp_number, msg);
    } catch (err) { console.error('[whatsapp-digest ERROR]', err.message); }
  });
});

// ── PIECE 3: One-Tap Email Approvals ────────────────────────────────────────
app.get('/webhook/email-approve', async (req, res) => {
  const { token, action } = req.query;
  if (!token || !action) return res.status(400).send('<h1>Invalid link</h1>');
  try {
    const rows = await sbGet('content_approvals', `token=eq.${token}&used_at=is.null&select=*`);
    const approval = rows[0];
    if (!approval) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Link expired or already used</h1></body></html>');
    if (new Date(approval.expires_at) < new Date()) return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Link expired</h1></body></html>');
    await sbPatch('content_approvals', `id=eq.${approval.id}`, { action, used_at: new Date().toISOString() });
    if (action === 'approve') {
      await sbPatch('generated_content', `id=eq.${approval.content_id}`, { status: 'approved', approved_at: new Date().toISOString(), approval_method: 'email_one_tap' });
      apiRequest('POST', `https://maroa-api-production.up.railway.app/webhook/publish-approved-content`, { 'Content-Type': 'application/json' }, { business_id: approval.business_id }).catch(() => {});
      sendSSE(approval.business_id, 'content_approved', { content_id: approval.content_id });
      return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4"><h1 style="color:#16a34a">✅ Content Approved!</h1><p>It will publish at your optimal posting time.</p></body></html>');
    } else if (action === 'reject') {
      await sbPatch('generated_content', `id=eq.${approval.content_id}`, { status: 'rejected' });
      return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fef2f2"><h1 style="color:#dc2626">❌ Content Rejected</h1><p>Your AI will generate better content.</p></body></html>');
    } else if (action === 'regenerate') {
      await sbPatch('generated_content', `id=eq.${approval.content_id}`, { status: 'rejected' });
      apiRequest('POST', `https://maroa-api-production.up.railway.app/webhook/instant-content`, { 'Content-Type': 'application/json' }, { business_id: approval.business_id }).catch(() => {});
      return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fffbeb"><h1 style="color:#d97706">🔄 Regenerating</h1><p>New content will be ready in ~2 minutes.</p></body></html>');
    }
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Done</h1></body></html>');
  } catch (err) { res.status(500).send(`<h1>Error: ${err.message}</h1>`); }
});

// ── PIECE 4: Real-Time Dashboard Events (SSE) ──────────────────────────────
app.get('/webhook/dashboard-events', (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.write(`data: ${JSON.stringify({ type: 'connected', business_id })}\n\n`);
  sseClients.set(business_id, res);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`); }, 30000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(business_id); });
});

// ── PIECE 5: Paddle Webhook Handler — route registered at top (raw body); handler hoisted below ──
// Maps Paddle price IDs to plan names
const PADDLE_PRICE_TO_PLAN = {};
if (PADDLE_STARTER_PRICE) PADDLE_PRICE_TO_PLAN[PADDLE_STARTER_PRICE] = 'starter';
if (PADDLE_GROWTH_PRICE)  PADDLE_PRICE_TO_PLAN[PADDLE_GROWTH_PRICE]  = 'growth';
if (PADDLE_AGENCY_PRICE)  PADDLE_PRICE_TO_PLAN[PADDLE_AGENCY_PRICE]  = 'agency';

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
    logger.warn('/webhook/paddle-webhook', null, 'Paddle signature verification failed', { request_id: req.requestId });
    return apiError(res, 400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }
  let event;
  try { event = JSON.parse(rawBody.toString()); } catch { return apiError(res, 400, 'INVALID_JSON', 'Could not parse webhook body'); }
  res.json({ received: true });
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
        await sbPatch('businesses', `id=eq.${businessId}`, {
          plan,
          paddle_customer_id: data.customer_id,
          paddle_subscription_id: data.id
        });
        const biz = (await sbGet('businesses', `id=eq.${businessId}&select=email,business_name,whatsapp_number,whatsapp_enabled`))[0];
        if (biz?.email) await sendEmail(biz.email, `Welcome to ${plan} plan! — ${biz.business_name}`, `<h2>You're now on the ${plan} plan!</h2><p>Your AI just unlocked: ${plan === 'agency' ? 'white-label, multi-workspace, priority support' : 'ad campaigns, competitor intel, advanced analytics'}.</p>`).catch(() => {});
        if (biz?.whatsapp_number && biz.whatsapp_enabled) sendWhatsApp(biz.whatsapp_number, `*Upgraded to ${plan}!* Your AI just unlocked new features.`).catch(() => {});
        sendSSE(businessId, 'plan_upgraded', { plan });
      }
    } else if (eventType === 'subscription.canceled') {
      const businessId = data.custom_data?.business_id;
      if (businessId) {
        await sbPatch('businesses', `id=eq.${businessId}`, { plan: 'free' });
      } else {
        const bizArr = await sbGet('businesses', `paddle_subscription_id=eq.${data.id}&select=id`);
        if (bizArr[0]) await sbPatch('businesses', `id=eq.${bizArr[0].id}`, { plan: 'free' });
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
          status: 'success'
        }).catch(() => {});
      }
    }
  } catch (err) { console.error('[paddle-webhook ERROR]', err.message); }
}

// ── PIECE 6: Google My Business Auto-Post ───────────────────────────────────
app.post('/webhook/gmb-post', async (req, res) => {
  const { business_id, content_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=gmb_access_token,gmb_location_id,website_url`))[0];
    if (!biz?.gmb_access_token || !biz?.gmb_location_id) return res.json({ posted: false, reason: 'GMB not connected' });
    let caption = '';
    if (content_id) {
      const cont = (await sbGet('generated_content', `id=eq.${content_id}&select=facebook_post,instagram_caption,image_url`))[0];
      caption = cont?.facebook_post || cont?.instagram_caption || '';
    }
    if (!caption) return res.json({ posted: false, reason: 'No content to post' });
    const gmbResp = await apiRequest('POST', `https://mybusiness.googleapis.com/v4/${biz.gmb_location_id}/localPosts`,
      { 'Authorization': `Bearer ${biz.gmb_access_token}`, 'Content-Type': 'application/json' },
      { languageCode: 'en-US', summary: caption.slice(0, 1500), topicType: 'STANDARD',
        callToAction: { actionType: 'LEARN_MORE', url: biz.website_url || '' } });
    if (gmbResp.body?.name) {
      if (content_id) await sbPatch('generated_content', `id=eq.${content_id}`, { gmb_post_id: gmbResp.body.name }).catch(() => {});
      return res.json({ posted: true, post_id: gmbResp.body.name });
    }
    res.status(502).json({ posted: false, error: 'Service temporarily unavailable' });
  } catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── PIECE 7: AI Video Generation (Runway) ───────────────────────────────────
app.post('/webhook/video-generate', async (req, res) => {
  const { business_id, video_id } = req.body;
  if (!business_id || !video_id) return res.status(400).json({ error: 'business_id and video_id required' });
  if (!RUNWAY_API_KEY) return res.json({ generated: false, reason: 'RUNWAY_API_KEY not set' });
  res.json({ received: true, message: 'Video generation started — this takes 2-5 minutes' });
  setImmediate(async () => {
    try {
      log('/webhook/video-generate', `Starting for video ${video_id}`);
      const video = (await sbGet('video_generations', `id=eq.${video_id}&select=*`))[0];
      if (!video) { log('/webhook/video-generate', `Video ${video_id} not found`); return; }

      // Parse script — may be stored as string or object
      let script = video.script;
      if (typeof script === 'string') { try { script = JSON.parse(script); } catch { script = {}; } }
      const hookScene = script?.scenes?.[0];
      const promptText = hookScene?.text || video.hook_preview || video.caption || 'professional marketing video';
      const thumbUrl = video.thumbnail_url || '';

      log('/webhook/video-generate', `promptText: "${promptText.slice(0,80)}" | thumb: ${thumbUrl ? 'yes' : 'no'} | RUNWAY_KEY: ${RUNWAY_API_KEY ? 'set' : 'missing'}`);

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
            await logError(business_id, 'video-generate', 'No image available for image_to_video', { video_id }).catch(() => {});
            return;
          }
        } catch (pexErr) {
          log('/webhook/video-generate', `Pexels fallback failed: ${pexErr.message}`);
          await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
          return;
        }
      }

      log('/webhook/video-generate', `Calling Runway ${endpoint}: ${JSON.stringify(runwayBody).slice(0,200)}`);

      const taskResp = await apiRequest('POST', `https://api.dev.runwayml.com/v1/${endpoint}`,
        { 'Authorization': `Bearer ${RUNWAY_API_KEY}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
        runwayBody);

      log('/webhook/video-generate', `Runway response: ${taskResp.status} ${JSON.stringify(taskResp.body).slice(0,300)}`);

      const taskId = taskResp.body?.id;
      if (!taskId) {
        const errMsg = taskResp.body?.error || taskResp.body?.message || JSON.stringify(taskResp.body).slice(0, 300);
        log('/webhook/video-generate', `Runway failed to create task: ${errMsg}`);
        await sbPatch('video_generations', `id=eq.${video_id}`, { status: 'failed' });
        await logError(business_id, 'video-generate', `Runway ${taskResp.status}: ${errMsg}`, { video_id }).catch(() => {});
        return;
      }

      log('/webhook/video-generate', `Task created: ${taskId} — polling for completion`);
      await sbPatch('video_generations', `id=eq.${video_id}`, { runway_task_id: taskId, status: 'generating' });

      // Poll for completion (max 5 minutes)
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const poll = await apiRequest('GET', `https://api.dev.runwayml.com/v1/tasks/${taskId}`,
          { 'Authorization': `Bearer ${RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' });

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
          await logError(business_id, 'video-generate', `Runway FAILED: ${failReason}`, { video_id, taskId }).catch(() => {});
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
  if (!business_id || !referee_email) return res.status(400).json({ error: 'business_id and referee_email required' });
  try {
    const biz = (await sbGet('businesses', `id=eq.${business_id}&select=business_name,email,referral_code`))[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const bizCode = biz.referral_code || crypto.randomBytes(4).toString('hex');
    if (!biz.referral_code) await sbPatch('businesses', `id=eq.${business_id}`, { referral_code: bizCode }).catch(() => {});
    // Unique code per referral to avoid duplicate key errors
    const refCode = bizCode + '-' + crypto.randomBytes(3).toString('hex');
    const ref = await sbPost('referrals', { referrer_business_id: business_id, referee_email, referral_code: refCode, status: 'pending' });
    const signupUrl = `https://maroa-ai-marketing-automator.vercel.app/signup?ref=${refCode}`;
    await sendEmail(referee_email, `${biz.business_name} thinks maroa.ai could help you`,
      `<h2>You've been referred!</h2><p>${biz.business_name} thinks AI marketing could help your business.</p><p>Get <strong>30 days free</strong> when you sign up:</p><p><a href="${signupUrl}" style="background:#667eea;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Start Free →</a></p>`
    ).catch(() => {});
    res.json({ referral_id: ref?.id, referral_code: refCode, signup_url: signupUrl, email_sent: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/referral-convert', async (req, res) => {
  const { referral_code, new_business_id } = req.body;
  if (!referral_code) return res.status(400).json({ error: 'referral_code required' });
  try {
    const refs = await sbGet('referrals', `referral_code=eq.${referral_code}&status=eq.pending&limit=1`);
    if (!refs[0]) return res.json({ converted: false, reason: 'Referral not found or already used' });
    await sbPatch('referrals', `id=eq.${refs[0].id}`, { status: 'converted', referee_business_id: new_business_id || null });
    res.json({ converted: true, referrer_business_id: refs[0].referrer_business_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/webhook/referral-stats', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const refs = await sbGet('referrals', `referrer_business_id=eq.${business_id}&select=status`);
    res.json({ total: refs.length, converted: refs.filter(r => r.status === 'converted').length, pending: refs.filter(r => r.status === 'pending').length });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        sbGet('revenue_attribution', `business_id=eq.${business_id}&select=amount,source`).catch(() => [])
      ]);
      const biz = bizArr[0]; if (!biz) return;
      const totalRev = revenue.reduce((s,r) => s + (Number(r.amount)||0), 0);
      const totalReach = snaps.reduce((s,r) => s + (r.reach||0), 0);
      const activeCamps = campaigns.filter(c => c.status === 'active');
      const hotLeads = contacts.filter(c => c.intent_level === 'hot' || c.intent_level === 'ready_to_buy').length;
      const prompt =
`You are a revenue forecasting AI for ${biz.business_name} (${biz.industry}).
Data: Revenue last 90d: $${totalRev.toFixed(2)} | Reach: ${totalReach} | Active campaigns: ${activeCamps.length} | Hot leads: ${hotLeads} | Total contacts: ${contacts.length} | Avg campaign ROAS: ${activeCamps.length ? (activeCamps.reduce((s,c)=>s+(c.roas||0),0)/activeCamps.length).toFixed(2) : '0'}
Plan: ${biz.plan} | Goal: ${biz.marketing_goal || 'grow'}
Return ONLY valid JSON:
{"forecast_30d":{"revenue":0,"confidence":"low/medium/high"},"forecast_90d":{"revenue":0,"confidence":"low/medium/high"},"top_revenue_actions":[{"action":"string","expected_impact":"string","effort":"low/medium/high"}],"risk_factors":[{"risk":"string","probability":"low/medium/high"}],"forecast_summary":"2-3 sentences"}`;
      const forecast = await callClaude(prompt, 'strategy', 1500);
      await sbPatch('businesses', `id=eq.${business_id}`, { revenue_forecast: JSON.stringify(forecast) });
      sendSSE(business_id, 'forecast_updated', { summary: forecast.forecast_summary });
      try { storeInsight(business_id, 'forecast', 'revenue_intelligence', 'forecast_30d', forecast.forecast_30d?.revenue || '0'); storeInsight(business_id, 'forecast', 'revenue_intelligence', 'forecast_summary', forecast.forecast_summary || ''); } catch {}
      log('/webhook/revenue-forecast', `✅ Forecast for ${biz.business_name}`);
    } catch (err) { console.error('[revenue-forecast ERROR]', err.message); await logError(business_id, 'revenue-forecast', err.message).catch(() => {}); }
  });
});

// ── PIECE 13: Competitor Ad Spy ─────────────────────────────────────────────
app.post('/webhook/spy-competitor-ads', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Competitor ad spy running' });
  setImmediate(async () => {
    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,competitors,meta_access_token`))[0];
      if (!biz?.meta_access_token) return;
      let competitors = []; try { competitors = JSON.parse(biz.competitors || '[]'); } catch {}
      for (const comp of competitors.slice(0, 3)) {
        const name = typeof comp === 'string' ? comp : (comp.name || comp);
        try {
          const r = await apiRequest('GET',
            `https://graph.facebook.com/v19.0/ads_archive?search_terms=${encodeURIComponent(name)}&ad_reached_countries=["US"]&ad_type=ALL&fields=id,ad_creative_bodies,ad_creative_link_titles&limit=5&access_token=${biz.meta_access_token}`, {});
          const ads = r.body?.data || [];
          for (const ad of ads) {
            await sbPost('competitor_ads', {
              business_id, competitor_name: name, ad_id: ad.id || `${name}-${Date.now()}`,
              ad_body: (ad.ad_creative_bodies || []).join(' ').slice(0, 1000),
              ad_headline: (ad.ad_creative_link_titles || []).join(' ').slice(0, 500)
            }).catch(() => {});
          }
        } catch {}
      }
      try { storeInsight(business_id, 'competitor_ads', 'competitive_intelligence', 'competitor_ad_count', `${competitors.length} competitors monitored`); } catch {}
      log('/webhook/spy-competitor-ads', `✅ Spied on ${competitors.length} competitors for ${biz.business_name}`);
    } catch (err) { console.error('[spy-competitor-ads ERROR]', err.message); }
  });
});

// ── PIECE 15: Zapier/Make Webhook Subscriptions ─────────────────────────────
app.post('/webhook/webhook-subscribe', async (req, res) => {
  const { business_id, event_type, webhook_url } = req.body;
  if (!business_id || !event_type || !webhook_url) return res.status(400).json({ error: 'business_id, event_type, webhook_url required' });
  try {
    const secret = crypto.randomBytes(16).toString('hex');
    const sub = await sbPost('webhook_subscriptions', { business_id, event_type, webhook_url, secret, active: true });
    // Test ping
    apiRequest('POST', webhook_url, { 'Content-Type': 'application/json', 'X-Maroa-Secret': secret },
      { event: 'test', business_id, message: 'Webhook connected successfully' }).catch(() => {});
    res.json({ subscription_id: sub?.id, event_type, webhook_url, secret });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/webhook/webhook-list', async (req, res) => {
  const { business_id } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const subs = await sbGet('webhook_subscriptions', `business_id=eq.${business_id}&active=eq.true&select=id,event_type,webhook_url,created_at`);
    res.json({ subscriptions: subs, count: subs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/webhook/webhook-delete', async (req, res) => {
  const { subscription_id } = req.body;
  if (!subscription_id) return res.status(400).json({ error: 'subscription_id required' });
  try {
    await sbPatch('webhook_subscriptions', `id=eq.${subscription_id}`, { active: false });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    const existing = await sbGet('business_intelligence', `user_id=eq.${userId}&source_module=eq.${sourceModule}&insight_key=eq.${encodeURIComponent(insightKey)}&select=id`).catch(() => []);
    if (existing.length > 0) {
      await sbPatch('business_intelligence', `id=eq.${existing[0].id}`, { insight_value: val.slice(0, 2000), updated_at: new Date().toISOString() });
    } else {
      await sbPost('business_intelligence', { user_id: userId, source_module: sourceModule, insight_type: insightType, insight_key: insightKey, insight_value: val.slice(0, 2000) });
    }
  } catch (err) { log('storeInsight', `${sourceModule}/${insightKey}: ${err.message}`); }
}

async function getAllIntelligence(userId) {
  try {
    return await sbGet('business_intelligence', `user_id=eq.${userId}&order=updated_at.desc&limit=50`);
  } catch { return []; }
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
    const rows = await getAllIntelligence(req.params.userId);
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.source_module]) grouped[r.source_module] = [];
      grouped[r.source_module].push({ key: r.insight_key, value: r.insight_value, type: r.insight_type, updated: r.updated_at });
    }
    res.json({ intelligence: grouped, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper: fetch business profile for skill modules
async function getProfile(userId) {
  let profile = null;
  let biz = null;
  // Fetch from both tables in parallel
  try {
    const [profileArr, bizArr1] = await Promise.all([
      sbGet('business_profiles', `user_id=eq.${userId}&select=*`).catch(() => []),
      sbGet('businesses', `id=eq.${userId}&select=*`).catch(() => [])
    ]);
    profile = profileArr[0] || null;
    biz = bizArr1[0] || null;
    if (!biz) { const bizArr2 = await sbGet('businesses', `user_id=eq.${userId}&select=*`).catch(() => []); biz = bizArr2[0] || null; }
  } catch {}

  // If detailed profile exists, merge businesses data into gaps
  if (profile) {
    if (biz) {
      if (!profile.business_name) profile.business_name = biz.business_name;
      if (!profile.business_type) profile.business_type = biz.industry;
      if ((!profile.physical_locations || !profile.physical_locations.length) && biz.location) profile.physical_locations = [{ city: biz.location }];
      if (!profile.audience_description) profile.audience_description = biz.target_audience;
      if (!profile.primary_goal) profile.primary_goal = biz.marketing_goal;
      if (!profile.monthly_budget && biz.daily_budget) profile.monthly_budget = '€' + (biz.daily_budget * 30);
      if ((!profile.tone_keywords || !profile.tone_keywords.length) && biz.brand_tone) profile.tone_keywords = [biz.brand_tone];
      profile.plan = profile.plan || biz.plan;
    }
    return profile;
  }

  // Fall back to businesses table only
  if (biz) {
    return { user_id: userId, business_name: biz.business_name, business_type: biz.industry, physical_locations: biz.location ? [{ city: biz.location }] : [], primary_language: 'English', audience_description: biz.target_audience, primary_goal: biz.marketing_goal, monthly_budget: biz.daily_budget ? '€' + biz.daily_budget * 30 : '€300', tone_keywords: biz.brand_tone ? [biz.brand_tone] : [], usp: '', pain_point: '', we_do_better: '', current_offer: '', products: [], avg_spend: '', business_age: 'established', plan: biz.plan };
  }

  log('getProfile', `No data found in either table for ${userId}`);
  return null;
}
function pCity(p) { const l = Array.isArray(p?.physical_locations) ? p.physical_locations : []; return l[0]?.city || 'local area'; }

// DEBUG: test getProfile directly
app.get('/api/debug/profile/:userId', requireAdminSecret, async (req, res) => {
  const uid = req.params.userId;
  try {
    const p = await getProfile(uid);
    res.json({ found: !!p, business_name: p?.business_name || null, business_type: p?.business_type || null, userId: uid });
  } catch (err) { res.status(500).json({ found: false, error: 'Failed to fetch profile', userId: uid }); }
});

// ── T2.2: GET /api/opportunities/:userId — Proactive opportunity detection ──
app.get('/api/opportunities/:userId', async (req, res) => {
  try {
    const p = await getProfile(req.params.userId);
    const ops = await detectOpportunities(req.params.userId, p);
    res.json({ opportunities: ops, count: ops.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── T4.1: GET /api/metrics/:userId — Real analytics engine ──────────────────
app.get('/api/metrics/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const weekMs = 7 * 86400000;
    const [content, ideas, intel, memory] = await Promise.all([
      sbGet('generated_content', `business_id=eq.${uid}&order=created_at.desc&limit=50&select=created_at,status,content_theme`).catch(() => []),
      sbGet('marketing_ideas', `user_id=eq.${uid}&status=eq.new&select=id`).catch(() => []),
      getAllIntelligence(uid),
      sbGet('ai_memory', `user_id=eq.${uid}&select=id`).catch(() => [])
    ]);
    const thisWeek = content.filter(c => Date.now() - new Date(c.created_at).getTime() < weekMs);
    const published = thisWeek.filter(c => c.status === 'published');
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
      trend: thisWeek.length >= 3 ? 'growing' : 'needs_attention'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      const holidays = typeof getKosovoAlbaniaHolidays === 'function' ? getKosovoAlbaniaHolidays(new Date()).join(', ') : '';
      const season = typeof getSeason === 'function' ? getSeason(new Date()) : 'current';
      const prods = Array.isArray(p.products) ? p.products.map(pr => pr.name).join(', ') : 'main service';
      const result = await callClaude(`You are a content calendar strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nLanguage: ${p.primary_language || 'English'}\nGoal: ${p.primary_goal}\nBudget: ${p.monthly_budget}\nProducts: ${prods}\nSeason: ${season}\nUpcoming holidays: ${holidays || 'none soon'}\n${intel}\n\nCreate a 30-day content calendar following content pillar framework:\n- 30% educational\n- 20% social proof\n- 20% behind the scenes\n- 20% engagement\n- 10% promotional\n\nReturn ONLY valid JSON:\n{"calendar":[{"day":1,"type":"educational|social_proof|behind_scenes|engagement|promotional","platform":"instagram|facebook|both","topic":"specific topic","caption_idea":"brief idea","hashtags":"3-5 relevant hashtags"}],"posting_frequency":"X posts per week","best_days":["string"]}`, 'strategy', 3000, claudeBiz(userId));
      try { storeInsight(userId, 'calendar', 'content_strategy', 'posting_plan', `${(result.calendar || []).length} days planned, ${result.posting_frequency || ''}`); } catch {}
      log('/api/calendar/generate', `✅ 30-day calendar for ${p.business_name}`);
    } catch (err) { console.error('[calendar]', err.message); }
  });
});

// ── IMPROVEMENT 7: Content Feedback Loop ────────────────────────────────────
app.post('/api/content/feedback', validate('contentScore'), async (req, res) => {
  const { contentId, userId, action, editedVersion } = req.validatedBody;
  try {
    // Get content for memory storage
    const contentRows = await sbGet('generated_content', `id=eq.${contentId}&select=instagram_caption,content_theme`).catch(() => []);
    const snippet = contentRows[0]?.instagram_caption?.slice(0, 200) || '';
    const theme = contentRows[0]?.content_theme || '';
    if (action === 'approved') {
      await sbPatch('generated_content', `id=eq.${contentId}`, { status: 'approved', approved_at: new Date().toISOString(), approval_method: 'client_feedback' });
      storeInsight(userId, 'feedback', 'content_preference', 'approved_style', `Approved: ${theme}`).catch(() => {});
      storeMemory(userId, 'content_wins', 'approved', snippet, 'social', `Client approved ${theme} content`).catch(() => {});
    } else if (action === 'rejected') {
      await sbPatch('generated_content', `id=eq.${contentId}`, { status: 'rejected' });
      storeInsight(userId, 'feedback', 'content_preference', 'rejected_reason', `Rejected: ${theme}`).catch(() => {});
      storeMemory(userId, 'content_losses', 'rejected', snippet, 'social', `Client rejected ${theme} — avoid this approach`).catch(() => {});
    } else if (action === 'edited' && editedVersion) {
      await sbPatch('generated_content', `id=eq.${contentId}`, { status: 'approved', instagram_caption: editedVersion, approved_at: new Date().toISOString(), approval_method: 'client_edited' });
      storeInsight(userId, 'feedback', 'content_preference', 'edited_style', `Edited: ${theme}`).catch(() => {});
      storeMemory(userId, 'preferences', 'edited', editedVersion.slice(0, 200), 'social', `Client prefers this style over AI draft`).catch(() => {});
    }
    res.json({ success: true, action });
  } catch (err) { apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err)); }
});

// ── IMPROVEMENT 9: Performance Tracking ─────────────────────────────────────
app.post('/api/performance/update', async (req, res) => {
  const { userId, platform, metric, value, date } = req.body;
  if (!userId || !platform || !metric) return res.status(400).json({ error: 'userId, platform, metric required' });
  try {
    await sbPost('analytics_snapshots', { business_id: userId, platform, [metric]: value || 0, snapshot_date: date || new Date().toISOString().slice(0, 10) });
    storeInsight(userId, 'performance', 'performance_data', `${platform}_${metric}`, String(value || 0)).catch(() => {});
    res.json({ stored: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/performance/summary/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const [thisWeek, lastWeek] = await Promise.all([
      sbGet('analytics_snapshots', `business_id=eq.${uid}&snapshot_date=gte.${weekAgo}&select=reach,engagement,clicks,impressions`),
      sbGet('analytics_snapshots', `business_id=eq.${uid}&snapshot_date=gte.${twoWeeksAgo}&snapshot_date=lt.${weekAgo}&select=reach,engagement,clicks,impressions`)
    ]);
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    const tw = { reach: sum(thisWeek, 'reach'), engagement: sum(thisWeek, 'engagement'), clicks: sum(thisWeek, 'clicks') };
    const lw = { reach: sum(lastWeek, 'reach'), engagement: sum(lastWeek, 'engagement'), clicks: sum(lastWeek, 'clicks') };
    const change = (a, b) => b > 0 ? Math.round((a - b) / b * 100) : 0;
    res.json({ this_week: tw, last_week: lw, change: { reach: change(tw.reach, lw.reach) + '%', engagement: change(tw.engagement, lw.engagement) + '%', clicks: change(tw.clicks, lw.clicks) + '%' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POWER: Business Health Score ─────────────────────────────────────────────
app.get('/api/health/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const [p, content, intel, memory] = await Promise.all([
      getProfile(uid),
      sbGet('generated_content', `business_id=eq.${uid}&order=created_at.desc&limit=30&select=created_at,status,content_theme`).catch(() => []),
      getAllIntelligence(uid),
      sbGet('ai_memory', `user_id=eq.${uid}&select=id`).catch(() => [])
    ]);
    const weekMs = 7 * 86400000;
    const thisWeek = content.filter(c => Date.now() - new Date(c.created_at).getTime() < weekMs);
    const published = thisWeek.filter(c => c.status === 'published');
    const themes = [...new Set(thisWeek.map(c => c.content_theme).filter(Boolean))];

    let profileScore = 0;
    try { const { calculateProfileScore } = require('./services/masterPromptBuilder'); profileScore = p ? calculateProfileScore(p) : 0; } catch {}
    const postingScore = Math.min(20, published.length * 5);
    const varietyScore = Math.min(20, themes.length * 7);
    const engagementScore = Math.min(20, intel.length * 2);
    const competitiveScore = Math.min(20, (intel.filter(i => i.source_module === 'competitors' || i.source_module === 'moat').length) * 5);
    const total = Math.min(100, Math.round(profileScore / 5) + postingScore + varietyScore + engagementScore + competitiveScore);

    const recs = [];
    if (profileScore < 70) recs.push('Complete your business profile to unlock better AI content');
    if (published.length < 3) recs.push('Publish at least 3 posts this week for algorithm reach');
    if (themes.length < 2) recs.push('Vary your content themes — mix educational, promotional, and social proof');
    if (intel.length < 5) recs.push('Run competitor analysis and customer research to feed the AI');

    res.json({ total, profile: Math.round(profileScore / 5), posting: postingScore, variety: varietyScore, engagement: engagementScore, competitive: competitiveScore, recommendations: recs, memory_entries: memory.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      const result = await callClaude(`You are a campaign strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nGoal: ${goal}\nDuration: ${duration} days\nBudget: ${p.monthly_budget}\nLanguage: ${p.primary_language}\nProducts: ${(p.products || []).map(pr => pr.name).join(', ')}\n${intel}\n${mem}\n\nCreate a complete ${duration}-day campaign:\n- ${duration} social posts (one per day, specific topic and caption)\n- 2 emails (start and end of campaign)\n- 1 ad copy (Meta)\n- Campaign hashtag\n- Best posting schedule\n\nReturn ONLY valid JSON:\n{"campaign_name":"string","theme":"string","posts":[{"day":1,"platform":"string","topic":"string","caption":"string"}],"emails":[{"type":"start|end","subject":"string","body":"string"}],"ad":{"headline":"string","body":"string"},"hashtag":"string"}`, 'strategy', 4000, claudeBiz(userId));
      try { storeInsight(userId, 'campaigns', 'campaign_strategy', 'active_campaign', result.campaign_name || goal); } catch {}
      log('/api/campaigns/instant', `✅ ${duration}-day campaign: ${result.campaign_name || goal}`);
    } catch (err) { console.error('[campaigns/instant]', err.message); }
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
      const result = await callClaude(`Repurpose this content for ${p.business_name} across platforms.\nOriginal:\n"${originalContent.slice(0, 1000)}"\n\nLanguage: ${p.primary_language}\nCity: ${pCity(p)}\n\nCreate versions for: ${platforms.join(', ')}\n\nReturn ONLY valid JSON:\n{"versions":[{"platform":"string","content":"string","hashtags":"string","format":"string"}]}`, 'social_post', 2000, claudeBiz(userId));
      log('/api/content/repurpose', `✅ ${(result.versions || []).length} platform versions`);
    } catch (err) { console.error('[content/repurpose]', err.message); }
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
      const result = await callClaude(`A competitor of ${p.business_name} just did this: "${competitorAction}"\n\nBusiness: ${p.business_type} in ${pCity(p)}\nOur USP: ${p.usp}\nOur advantage: ${p.we_do_better}\nLanguage: ${p.primary_language}\n\nGenerate counter-strategy:\n- 3 social posts positioning us as the better choice\n- 1 email to existing customers reinforcing loyalty\n- 1 ad copy countering their move\n\nReturn ONLY valid JSON:\n{"posts":["string"],"email":{"subject":"string","body":"string"},"ad":{"headline":"string","body":"string"},"strategy":"string"}`, 'strategy', 2000, claudeBiz(userId));
      try { storeInsight(userId, 'compete', 'competitive_intelligence', 'counter_strategy', result.strategy || competitorAction); } catch {}
      log('/api/compete/counter', `✅ Counter-strategy for ${p.business_name}`);
    } catch (err) { console.error('[compete/counter]', err.message); }
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
    const result = await callClaude(`Weekly strategy report for ${p.business_name} (${p.business_type} in ${pCity(p)}).\nLanguage: ${p.primary_language}\n${intel}\n${mem}\n\nGenerate:\n1. What worked this week (from intelligence)\n2. What to focus on next week\n3. 5 content ideas for next 7 days\n4. Budget recommendation\n5. One key competitor insight\n\nReturn ONLY valid JSON:\n{"what_worked":"string","next_week_focus":"string","content_ideas":["string"],"budget_recommendation":"string","competitor_insight":"string","overall_grade":"A|B|C|D"}`, 'strategy', 1500, claudeBiz(uid));
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
    const result = await callClaude(`Write a review response for ${p?.business_name || 'the business'}.\nReview (${stars} stars): "${reviewText}"\nPlatform: ${platform || 'google'}\nTone: ${tone}\nLanguage: ${p?.primary_language || 'English'}\n\nRules:\n- ${stars >= 4 ? 'Thank warmly, mention specific detail, invite back' : 'Apologize sincerely, offer solution, invite offline resolution'}\n- Max 100 words\n- Never templated — unique to this review\n\nReturn ONLY valid JSON:\n{"response":"string","tone":"string","suggested_action":"string"}`, 'short_copy', 400, claudeBiz(userId));
    try { if (stars <= 2) storeInsight(userId, 'reviews', 'customer_voice', 'complaint_pattern', reviewText.slice(0, 100)); } catch {}
    res.json(result);
  } catch (err) {
    if (err?.code === 'AI_BUDGET_EXCEEDED' || err?.status === 402) {
      return apiError(res, 402, 'AI_BUDGET_EXCEEDED', err.message || 'Daily AI call limit reached');
    }
    return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
  }
});

// ── MODULE 1: Referral Program ──────────────────────────────────────────────
app.post('/api/referral/setup', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating referral program' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const code = crypto.randomBytes(4).toString('hex');
      const result = await callClaude(`You are a referral program expert for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nAvg spend: ${p.avg_spend || 'moderate'}\nLanguage: ${p.primary_language || 'English'}\n\nDesign a double-sided referral reward program.\nReturn ONLY valid JSON:\n{"reward_for_referrer":"string","reward_for_referee":"string","trigger_moments":["string"],"share_message":"string (${p.primary_language}, max 160 chars)","email_subject":"string","email_body":"string"}`, 'email', 1000, claudeBiz(userId));
      await sbPost('referral_programs', { user_id: userId, referral_code: code, reward_type: 'discount', reward_value: result.reward_for_referee || '20%', is_active: true });
      storeInsight(userId, 'referral', 'program', 'reward_structure', `${result.reward_for_referrer || ''} / ${result.reward_for_referee || ''}`);
      log('/api/referral/setup', `✅ Referral program created for ${p.business_name}`);
    } catch (err) { console.error('[referral/setup]', err.message); }
  });
});
app.get('/api/referral/status/:userId', async (req, res) => {
  try { const r = await sbGet('referral_programs', `user_id=eq.${req.params.userId}&select=*`); res.json(r[0] || { active: false }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});
app.post('/api/referral/track', async (req, res) => {
  const { referral_code, referred_email } = req.body;
  if (!referral_code) return res.status(400).json({ error: 'referral_code required' });
  try {
    const progs = await sbGet('referral_programs', `referral_code=eq.${referral_code}&select=user_id`);
    if (!progs[0]) return res.status(404).json({ error: 'Invalid referral code' });
    await sbPost('referrals', { referrer_id: progs[0].user_id, referred_email, status: 'pending' });
    res.json({ tracked: true });
  } catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 2: Lead Magnets ──────────────────────────────────────────────────
app.post('/api/lead-magnets/generate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating lead magnet' });
  setImmediate(async () => {
    try {
      if (await checkOrchestrationIdempotency(userId, 'lead_magnets_generate')) {
        log('/api/lead-magnets/generate', `skip idempotent userId=${userId}`);
        return;
      }
      const p = await getProfile(userId);
      if (!p) return;
      const result = await callClaude(`You are a lead magnet strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nAudience: ${p.audience_description || 'local customers'}, age ${p.audience_age_min || 18}-${p.audience_age_max || 65}\nPain point: ${p.pain_point || 'not specified'}\nLanguage: ${p.primary_language || 'English'}\n\nGenerate the BEST lead magnet. Solve ONE specific problem. High value, consumable in 10 min.\nReturn ONLY valid JSON:\n{"title":"string","type":"checklist|guide|template","headline":"string","subheadline":"string","content":"string (full content)","cta_button":"string"}`, 'campaign', 2000, claudeBiz(userId));
      await sbPost('lead_magnets', { user_id: userId, title: result.title || 'Lead Magnet', type: result.type || 'guide', content: JSON.stringify(result), is_active: true });
      storeInsight(userId, 'lead_magnets', 'content', 'lead_magnet_topic', result.title || 'lead magnet');
           storeInsight(userId, 'lead_magnets', 'content', 'lead_magnet_type', result.type || 'guide');
      await recordOrchestrationTaskRun(userId, 'lead_magnets_generate');
      log('/api/lead-magnets/generate', `✅ Lead magnet: ${result.title}`);
    } catch (err) { console.error('[lead-magnets]', err.message); }
  });
});
app.get('/api/lead-magnets/:userId', async (req, res) => {
  try { const r = await sbGet('lead_magnets', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=10`); res.json({ magnets: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 3: Launch Strategy ───────────────────────────────────────────────
app.post('/api/launch/create', async (req, res) => {
  const { userId, productName, launchDate, productDescription } = req.body;
  if (!userId || !productName) return res.status(400).json({ error: 'userId and productName required' });
  res.json({ received: true, message: 'Building launch campaign' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const result = await callClaude(`You are a launch strategist for ${p.business_name} launching: ${productName}\nDescription: ${productDescription || 'new product'}\nLaunch date: ${launchDate || 'in 2 weeks'}\nBusiness: ${p.business_type} in ${pCity(p)}\nLanguage: ${p.primary_language}\nBudget: ${p.monthly_budget}\nAudience: ${p.audience_description}\n\nUsing ORB launch framework, create complete launch plan:\n- PRE-LAUNCH: 3 teaser posts + 1 email\n- LAUNCH DAY: announcement post + launch email + ad copy\n- POST-LAUNCH: 2 social proof posts + follow-up email\n\nReturn ONLY valid JSON:\n{"pre_launch":{"posts":["string"],"email":{"subject":"string","body":"string"}},"launch_day":{"post":"string","email":{"subject":"string","body":"string"},"ad_copy":"string"},"post_launch":{"posts":["string"],"email":{"subject":"string","body":"string"}}}`, 'strategy', 3000, claudeBiz(userId));
      await sbPost('launch_campaigns', { user_id: userId, product_name: productName, launch_date: launchDate || new Date(Date.now() + 14 * 86400000).toISOString(), phase: 'pre_launch', content_plan: JSON.stringify(result) });
      storeInsight(userId, 'launch', 'campaign', 'product_launching', productName);
      log('/api/launch/create', `✅ Launch plan for ${productName}`);
    } catch (err) { console.error('[launch]', err.message); }
  });
});
app.get('/api/launch/:userId', async (req, res) => {
  try { const r = await sbGet('launch_campaigns', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=5`); res.json({ campaigns: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 4: Customer Research ─────────────────────────────────────────────
app.post('/api/research/analyze', async (req, res) => {
  const { userId, reviews, feedback } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Analyzing customer insights' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const reviewText = Array.isArray(reviews) ? reviews.join('\n') : (feedback || 'No reviews provided — analyze based on typical customers for this business type');
      const result = await callClaude(`You are a customer research expert analyzing ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nCurrent audience: ${p.audience_description}\nReviews/feedback:\n${reviewText}\n\nExtract:\n1. JOBS TO BE DONE (functional, emotional, social)\n2. Top 3 PAIN POINTS with emotional language\n3. TRIGGER EVENTS\n4. DESIRED OUTCOMES in customer words\n5. KEY PHRASES to use in marketing\n\nReturn ONLY valid JSON:\n{"jobs_to_be_done":["string"],"pain_points":["string"],"trigger_events":["string"],"desired_outcomes":["string"],"key_phrases":["string"],"improved_audience_description":"string","content_recommendations":["string"]}`, 'research', 1500, claudeBiz(userId));
      await sbPost('customer_insights', { user_id: userId, source: reviews ? 'reviews' : 'ai_analysis', insight_type: 'full_analysis', content: JSON.stringify(result), actionable_suggestion: (result.content_recommendations || []).join('; ') });
      storeInsight(userId, 'research', 'customer', 'top_pain_points', (result.pain_points || []).slice(0, 3).join('; '));
      storeInsight(userId, 'research', 'customer', 'customer_language', (result.key_phrases || []).slice(0, 5).join('; '));
      storeInsight(userId, 'research', 'customer', 'trigger_events', (result.trigger_events || []).slice(0, 3).join('; '));
      log('/api/research/analyze', `✅ Customer insights for ${p.business_name}`);
    } catch (err) { console.error('[research]', err.message); }
  });
});

// ── MODULE 5: Marketing Ideas Engine ────────────────────────────────────────
app.post('/api/ideas/generate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating 10 marketing ideas' });
  setImmediate(async () => {
    try {
      if (await checkOrchestrationIdempotency(userId, 'ideas_generate')) {
        log('/api/ideas/generate', `skip idempotent userId=${userId}`);
        return;
      }
      const p = await getProfile(userId);
      if (!p) { log('/api/ideas/generate', `ABORT: no profile found for userId=${userId}`); await logError(userId, 'ideas-generate', 'No profile found for userId=' + userId).catch(() => {}); return; }
      log('/api/ideas/generate', `Profile found: ${p.business_name} (${p.business_type})`);
      let result = await callClaude(`You are a marketing strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nBudget: ${p.monthly_budget}\nGoal: ${p.primary_goal}\nLanguage: ${p.primary_language}\n\nGenerate 5 SPECIFIC marketing ideas ranked by impact. Keep each idea brief (1-2 sentences each).\n\nReturn ONLY valid JSON array (no markdown, no code fences):\n[{"idea":"string","category":"string","priority":"high|medium|low","estimated_impact":"string","how_to_execute":"3 brief steps","budget_required":"string","time_to_results":"string"}]`, 'idea', 4000, claudeBiz(userId));
      // Handle _raw fallback — re-extract JSON from raw text
      log('/api/ideas/generate', `Claude returned: type=${typeof result}, isArray=${Array.isArray(result)}, hasRaw=${!!result?._raw}, keys=${Object.keys(result||{}).slice(0,5)}`);
      if (result?._raw) { const parsed = extractJSON(result._raw); if (parsed) { log('/api/ideas/generate', `Re-parsed _raw: type=${typeof parsed}, isArray=${Array.isArray(parsed)}`); result = parsed; } }
      const ideas = Array.isArray(result) ? result : Array.isArray(result?.ideas) ? result.ideas : [];
      if (!ideas.length) { const sample = JSON.stringify(result).slice(0, 400); log('/api/ideas/generate', `No ideas parsed — result: ${sample}`); try { await sbPost('errors', { business_id: userId, workflow_name: 'ideas-generate-parse', error_message: 'No ideas parsed: ' + sample }); } catch {} return; }
      for (const idea of ideas.slice(0, 10)) {
        if (!idea?.idea || typeof idea.idea !== 'string') continue; // skip unparsed entries
        await sbPost('marketing_ideas', { user_id: userId, idea: idea.idea, category: idea.category || 'general', priority: idea.priority || 'medium', estimated_impact: idea.estimated_impact || '', how_to_execute: idea.how_to_execute || '', budget_required: idea.budget_required || '', time_to_results: idea.time_to_results || '' }).catch(() => {});
      }
      const topIdeas = ideas.filter(i => i.priority === 'high').slice(0, 3).map(i => i.idea).join('; ');
      storeInsight(userId, 'ideas', 'strategy', 'top_priority_ideas', topIdeas || ideas[0]?.idea || '');
      await recordOrchestrationTaskRun(userId, 'ideas_generate');
      log('/api/ideas/generate', `✅ ${ideas.length} marketing ideas generated`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[ideas] ERROR:', msg);
      log('/api/ideas/generate', `CAUGHT ERROR: ${msg.slice(0, 200)}`);
      try { await sbPost('errors', { business_id: userId, workflow_name: 'ideas-generate', error_message: msg.slice(0, 500) }); } catch {}
    }
  });
});
app.get('/api/ideas/:userId', async (req, res) => {
  try { const r = await sbGet('marketing_ideas', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=20`); res.json({ ideas: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});
app.patch('/api/ideas/:ideaId', async (req, res) => {
  try { await sbPatch('marketing_ideas', `id=eq.${req.params.ideaId}`, req.body); res.json({ updated: true }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 6: AI SEO ────────────────────────────────────────────────────────
app.post('/api/ai-seo/optimize', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating AI SEO content' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const result = await callClaude(`You are an AI SEO expert for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nUSP: ${p.usp}\nLanguage: ${p.primary_language}\n\nOptimize for ChatGPT, Perplexity, Google AI Overviews:\n1. Create 10 FAQ entries (question as users ask AI + direct citable answer)\n2. Write 3 authority paragraphs (specific numbers, structured for extraction)\n3. Generate local search queries\n\nReturn ONLY valid JSON:\n{"faqs":[{"question":"string","answer":"string"}],"authority_paragraphs":["string"],"target_queries":["string"]}`, 'research', 2000, claudeBiz(userId));
      await sbPost('ai_seo_content', { user_id: userId, content_type: 'full_optimization', optimized_content: JSON.stringify(result) });
      storeInsight(userId, 'ai_seo', 'seo', 'target_queries', (result.target_queries || []).slice(0, 5).join('; '));
      log('/api/ai-seo/optimize', `✅ AI SEO content for ${p.business_name}`);
    } catch (err) { console.error('[ai-seo]', err.message); }
  });
});

// ── MODULE 7: Schema Markup ─────────────────────────────────────────────────
app.post('/api/schema/generate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const p = await getProfile(userId);
    if (!p) return apiError(res, 404, 'NOT_FOUND', 'Profile not found');
    const result = await callClaude(`Generate LocalBusiness + FAQPage JSON-LD schema for:\nBusiness: ${p.business_name}\nType: ${p.business_type}\nCity: ${pCity(p)}\nUSP: ${p.usp || ''}\n\nReturn ONLY valid JSON-LD (no markdown):\n{"@context":"https://schema.org","@type":"LocalBusiness","name":"...","description":"...","address":{"@type":"PostalAddress","addressLocality":"${pCity(p)}"}}`, 'social_post', 800, claudeBiz(userId));
    const schemaJson = JSON.stringify(result);
    await sbPost('schema_markups', { user_id: userId, schema_type: 'LocalBusiness', schema_json: schemaJson });
    res.json({ schema: result, copyable: `<script type="application/ld+json">${schemaJson}</script>` });
  } catch (err) {
    if (err?.code === 'AI_BUDGET_EXCEEDED' || err?.status === 402) {
      return apiError(res, 402, 'AI_BUDGET_EXCEEDED', err.message || 'Daily AI call limit reached');
    }
    return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
  }
});
app.get('/api/schema/:userId', async (req, res) => {
  try { const r = await sbGet('schema_markups', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=5`); res.json({ schemas: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 8: Programmatic SEO Pages ────────────────────────────────────────
app.post('/api/seo-pages/generate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating SEO pages' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const cities = Array.isArray(p.service_area) ? p.service_area : [pCity(p)];
      for (const city of cities.slice(0, 5)) {
        const result = await callClaude(`Generate SEO page for "${p.business_type} in ${city}".\nBusiness: ${p.business_name}\nUSP: ${p.usp}\nLanguage: ${p.primary_language}\n\nReturn ONLY valid JSON:\n{"meta_title":"string (60 chars)","meta_description":"string (155 chars)","h1":"string","intro":"string (150 words)","services_section":"string","why_us":"string","faq":[{"q":"string","a":"string"}],"cta":"string"}`, 'social_post', 1500, claudeBiz(userId));
        await sbPost('seo_pages', { user_id: userId, page_type: 'service_location', keyword: `${p.business_type} in ${city}`, location: city, content: JSON.stringify(result), meta_title: result.meta_title, meta_description: result.meta_description }).catch(() => {});
      }
      storeInsight(userId, 'seo_pages', 'seo', 'pages_created', cities.join(', '));
      log('/api/seo-pages/generate', `✅ ${cities.length} SEO pages for ${p.business_name}`);
    } catch (err) { console.error('[seo-pages]', err.message); }
  });
});
app.get('/api/seo-pages/:userId', async (req, res) => {
  try { const r = await sbGet('seo_pages', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=20`); res.json({ pages: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 9: Pricing Recommendations ───────────────────────────────────────
app.post('/api/pricing/analyze', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Analyzing pricing strategy' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const prods = Array.isArray(p.products) ? p.products : [];
      const result = await callClaude(`You are a pricing strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nAvg spend: ${p.avg_spend || 'unknown'}\nProducts: ${prods.map(pr => `${pr.name}: ${pr.price || 'N/A'}`).join(', ')}\nGoal: ${p.primary_goal}\n\nUsing value-based pricing:\n1. Analyze current pricing\n2. Recommend 3-tier structure\n3. Psychological tactics\n4. ROI framing\n\nReturn ONLY valid JSON:\n{"pricing_analysis":"string","recommended_tiers":[{"name":"string","price":"string","includes":["string"],"target_customer":"string"}],"psychological_tactics":["string"],"roi_framing":"string","marketing_message":"string"}`, 'strategy', 1500, claudeBiz(userId));
      await sbPost('pricing_recommendations', { user_id: userId, tier_structure: JSON.stringify(result.recommended_tiers), reasoning: result.pricing_analysis });
      storeInsight(userId, 'pricing', 'strategy', 'recommended_pricing', JSON.stringify(result.recommended_tiers || []).slice(0, 500));
      storeInsight(userId, 'pricing', 'strategy', 'roi_framing', result.roi_framing || '');
      log('/api/pricing/analyze', `✅ Pricing analysis for ${p.business_name}`);
    } catch (err) { console.error('[pricing]', err.message); }
  });
});
app.get('/api/pricing/:userId', async (req, res) => {
  try { const r = await sbGet('pricing_recommendations', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=3`); res.json({ recommendations: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 10: Community Marketing ──────────────────────────────────────────
app.post('/api/community/generate-posts', async (req, res) => {
  const { userId, platform = 'facebook_group' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating community posts' });
  setImmediate(async () => {
    try {
      if (await checkOrchestrationIdempotency(userId, 'community_posts_generate')) {
        log('/api/community/generate-posts', `skip idempotent userId=${userId}`);
        return;
      }
      const p = await getProfile(userId);
      if (!p) return;
      const result = await callClaude(`You are a community marketing expert for ${p.business_name} in ${pCity(p)}.\nPlatform: ${platform}\nAudience: ${p.audience_description}\nLanguage: ${p.primary_language}\n\nGenerate 5 community posts focused on SHARED IDENTITY (not promotion).\nValue to members first.\n\nReturn ONLY valid JSON:\n{"strategy":"string","posts":[{"content":"string","post_type":"value|question|story|tip|engagement","best_day":"string"}]}`, 'community_post', 1500, claudeBiz(userId));
      const posts = result.posts || [];
      for (const post of posts) {
        await sbPost('community_posts', { user_id: userId, platform, content: post.content, post_type: post.post_type, status: 'draft' }).catch(() => {});
      }
      storeInsight(userId, 'community', 'content', 'post_types', posts.map(p2 => p2.post_type).join(', '));
      await recordOrchestrationTaskRun(userId, 'community_posts_generate');
      log('/api/community/generate-posts', `✅ ${posts.length} community posts`);
    } catch (err) { console.error('[community]', err.message); }
  });
});

// ── MODULE 11: Sales Enablement ─────────────────────────────────────────────
app.post('/api/sales/generate-pitch', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating sales pitch' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const result = await callClaude(`Create a sales one-pager for ${p.business_name}.\nBusiness: ${p.business_type} in ${pCity(p)}\nUSP: ${p.usp}\nWe are better at: ${p.we_do_better}\nOffer: ${p.current_offer}\nLanguage: ${p.primary_language}\n\nLead with outcomes, scannable in 3 seconds, specific numbers.\nReturn ONLY valid JSON:\n{"headline":"string","subheadline":"string","key_benefits":["string"],"social_proof":"string","cta":"string","full_pitch":"string"}`, 'sales_pitch', 1000, claudeBiz(userId));
      await sbPost('sales_assets', { user_id: userId, asset_type: 'one_pager', title: result.headline || 'Sales Pitch', content: JSON.stringify(result) }).catch(() => {});
      storeInsight(userId, 'sales', 'messaging', 'key_pitch', result.headline || '');
      log('/api/sales/generate-pitch', `✅ Pitch for ${p.business_name}`);
    } catch (err) { console.error('[sales/pitch]', err.message); }
  });
});
app.post('/api/sales/objection-handler', async (req, res) => {
  const { userId, objection } = req.body;
  if (!userId || !objection) return res.status(400).json({ error: 'userId and objection required' });
  try {
    const p = await getProfile(userId);
    const result = await callClaude(`Handle this sales objection for ${p?.business_name || 'the business'}:\nObjection: "${objection}"\nUSP: ${p?.usp || 'quality service'}\nLanguage: ${p?.primary_language || 'English'}\n\nReturn ONLY valid JSON:\n{"response":"string","tone":"empathetic|confident|educational","follow_up_question":"string"}`, 'short_copy', 500, claudeBiz(userId));
    res.json(result);
  } catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 12: RevOps Lead Scoring ──────────────────────────────────────────
app.post('/api/revops/score-lead', async (req, res) => {
  const { userId, leadData } = req.body;
  if (!userId || !leadData) return res.status(400).json({ error: 'userId and leadData required' });
  try {
    const p = await getProfile(userId);
    const result = await callClaude(`Score this lead for ${p?.business_name || 'the business'}:\nLead: ${JSON.stringify(leadData)}\nIdeal customer: ${p?.audience_description || 'local customer'}\nCity: ${pCity(p)}\n\nFIT (0-50): matches audience? +20, in area? +15, right spend? +15\nENGAGEMENT (0-50): form filled? +25, multiple visits? +15, time>2min? +10\n\nReturn ONLY valid JSON:\n{"fit_score":0,"engagement_score":0,"total_score":0,"stage":"lead|MQL|SQL","recommended_action":"string","follow_up_message":"string"}`, 'social_post', 500, claudeBiz(userId));
    await sbPost('lead_scores', { user_id: userId, lead_email: leadData.email || null, fit_score: result.fit_score || 0, engagement_score: result.engagement_score || 0, total_score: result.total_score || 0, stage: result.stage || 'lead', recommended_action: result.recommended_action });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/revops/scores/:userId', async (req, res) => {
  try { const r = await sbGet('lead_scores', `user_id=eq.${req.params.userId}&order=updated_at.desc&limit=20`); res.json({ scores: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 13: A/B Test Manager ─────────────────────────────────────────────
app.post('/api/ab-tests/create', async (req, res) => {
  const { userId, testType, currentVersion } = req.body;
  if (!userId || !testType || !currentVersion) return res.status(400).json({ error: 'userId, testType, currentVersion required' });
  try {
    const p = await getProfile(userId);
    const result = await callClaude(`Create A/B test variant for ${p?.business_name || 'business'}.\nCurrent (A): "${currentVersion}"\nType: ${testType}\nLanguage: ${p?.primary_language || 'English'}\n\nChange ONE variable. Return ONLY valid JSON:\n{"variant_a":"string","variant_b":"string","hypothesis":"string","primary_metric":"string","minimum_runtime":"string"}`, 'social_post', 500, claudeBiz(userId));
    let row = null;
    try { row = await sbPost('ab_tests', { business_id: userId, started_at: new Date().toISOString() }); } catch (dbErr) { log('/api/ab-tests/create', `DB insert failed (non-critical): ${dbErr.message}`); }
    res.json({ test_id: row?.id || null, ...result });
  } catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});
app.get('/api/ab-tests/:userId', async (req, res) => {
  try { const r = await sbGet('ab_tests', `business_id=eq.${req.params.userId}&order=started_at.desc&limit=10`); res.json({ tests: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 14: Free Tool Generator ──────────────────────────────────────────
app.post('/api/tools/suggest', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating tool suggestions' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      const result = await callClaude(`Suggest 3 free marketing tools for ${p?.business_name || 'business'}, a ${p?.business_type || 'local business'}.\nAudience: ${p?.audience_description || 'local customers'}\nCity: ${pCity(p)}\n\nReturn ONLY valid JSON:\n[{"tool_name":"string","tool_type":"calculator|generator|checklist","description":"string","how_it_generates_leads":"string"}]`, 'social_post', 800, claudeBiz(userId));
      const tools = Array.isArray(result) ? result : [result];
      for (const t of tools) { await sbPost('free_tools', { user_id: userId, tool_name: t.tool_name, tool_type: t.tool_type, tool_description: t.description }).catch(() => {}); }
      log('/api/tools/suggest', `✅ ${tools.length} tools suggested`);
    } catch (err) { console.error('[tools/suggest]', err.message); }
  });
});
app.get('/api/tools/:userId', async (req, res) => {
  try { const r = await sbGet('free_tools', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=10`); res.json({ tools: r }); }
  catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 15: Popup CRO ────────────────────────────────────────────────────
app.post('/api/popup/generate', async (req, res) => {
  const { userId, popupType = 'email_capture' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const p = await getProfile(userId);
    const tones = Array.isArray(p?.tone_keywords) ? p.tone_keywords.join(', ') : 'professional';
    const result = await callClaude(`Write popup copy for ${p?.business_name || 'business'}.\nType: ${popupType}\nBusiness: ${p?.business_type || 'local'} in ${pCity(p)}\nOffer: ${p?.current_offer || 'main service'}\nLanguage: ${p?.primary_language || 'English'}\nTone: ${tones}\n\nReturn ONLY valid JSON:\n{"headline":"string (max 8 words)","subheadline":"string (max 15 words)","cta_button":"string (max 4 words)","dismiss_text":"string","timing":"string","trigger":"exit_intent|scroll_50|time_30s"}`, 'social_post', 400);
    res.json(result);
  } catch (err) { res.status(500).json({ error: safePublicError(err) }); }
});

// ── MODULE 16: Onboarding CRO (for client's customers) ─────────────────────
app.post('/api/onboarding-cro/generate', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating customer onboarding sequence' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const prods = Array.isArray(p.products) ? p.products.map(pr => pr.name).join(', ') : 'their service';
      const result = await callClaude(`Design customer onboarding for ${p.business_name}.\nBusiness: ${p.business_type} in ${pCity(p)}\nProducts: ${prods}\nGoal: get them to come back and refer friends\nLanguage: ${p.primary_language}\n\nCreate 5-email sequence:\n1 (immediate): Welcome + next action\n2 (day 1): Quick win tip\n3 (day 3): Your story/why\n4 (day 5): Social proof\n5 (day 7): Special offer for second visit\n\nEach: subject, preview, body (max 150 words), CTA. All in ${p.primary_language}.\nReturn ONLY valid JSON:\n{"emails":[{"day":0,"subject":"string","preview":"string","body":"string","cta":"string"}]}`, 'social_post', 2000);
      log('/api/onboarding-cro/generate', `✅ 5-email onboarding for ${p.business_name}`);
    } catch (err) { console.error('[onboarding-cro]', err.message); }
  });
});

// ── MODULE 17: Upgrade CRO ──────────────────────────────────────────────────
app.post('/api/upgrade/generate-prompts', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Generating upgrade prompts' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      await callClaude(`Write 3 upgrade prompts for ${p?.business_name || 'business'}.\nLanguage: ${p?.primary_language || 'English'}\n\nReturn ONLY valid JSON:\n{"prompts":[{"trigger":"feature_gate","headline":"string","body":"string","cta":"string","dismiss":"string"}]}`, 'short_copy', 800);
      log('/api/upgrade/generate-prompts', '✅ Upgrade prompts generated');
    } catch (err) { console.error('[upgrade]', err.message); }
  });
});

// ── MODULE 18: Signup Flow CRO ──────────────────────────────────────────────
app.post('/api/signup-cro/analyze', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Analyzing signup flow' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      await callClaude(`Optimize signup flow for ${p?.business_name || 'business'}, a ${p?.business_type || 'local business'}.\nLanguage: ${p?.primary_language || 'English'}\n\nReturn ONLY valid JSON:\n{"landing":{"headline":"string","cta":"string"},"form":{"fields":["string"]},"confirmation":{"headline":"string"},"followup":{"sms":"string"}}`, 'short_copy', 1000);
      log('/api/signup-cro/analyze', '✅ Signup flow analyzed');
    } catch (err) { console.error('[signup-cro]', err.message); }
  });
});

// ── MODULE 19: Autonomous Daily Orchestrator ────────────────────────────────

app.post('/api/orchestrator/run/:userId', async (req, res) => {
  const userId = req.params.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json({ received: true, message: 'Running daily orchestration' });
  setImmediate(async () => {
    try {
      const p = await getProfile(userId);
      if (!p) return;
      const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const intel = await buildIntelligenceContext(userId);
      const plan = await callClaude(`You are the AI brain for ${p.business_name}.\nToday: ${dayName}\nGoal: ${p.primary_goal}\nBudget: ${p.monthly_budget}\nSeason: ${p.seasonal || 'year_round'}\n\n${intel}\n\nPRIORITY RULES:\n- competitive_intelligence → counter-content\n- customer_voice complaints → address in content\n- ad_strategy wins → replicate across channels\n- content_performance → more of what works\n- lead_intelligence → optimize targeting\n\nDecide 2-3 tasks for TODAY.\nChoose from: social_post, email, ai_seo, marketing_ideas, customer_research, schema_markup, lead_magnet, community_post\n\nReturn ONLY valid JSON:\n{"tasks":[{"type":"string","priority":1,"reason":"string"}],"tomorrow_plan":"string","top_insight":"string"}`, 'orchestrator', 700);
      const tasks = plan.tasks || [];
      const executed = [];
      const SELF = 'https://maroa-api-production.up.railway.app';
      for (const task of tasks.slice(0, 3)) {
        try {
          const endpoints = { social_post: '/webhook/instant-content', email: '/webhook/email-sequence-process', ai_seo: '/api/ai-seo/optimize', marketing_ideas: '/api/ideas/generate', customer_research: '/api/research/analyze', schema_markup: '/api/schema/generate', lead_magnet: '/api/lead-magnets/generate', community_post: '/api/community/generate-posts' };
          const ep = endpoints[task.type];
          if (ep) {
            apiRequest('POST', `${SELF}${ep}`, { 'Content-Type': 'application/json' }, { business_id: userId, userId }).catch(() => {});
            executed.push(task.type);
          }
        } catch {}
      }
      const report = `Executed ${executed.length}/${tasks.length} tasks: ${executed.join(', ')}`;
      await sbPost('orchestration_logs', { user_id: userId, tasks_planned: JSON.stringify(tasks), tasks_executed: JSON.stringify(executed), report }).catch(() => {});

      // Send daily report email
      try {
        const biz = (await sbGet('businesses', `id=eq.${userId}&select=email,business_name,first_name`))[0];
        if (biz?.email) {
          const taskList = executed.map(t => {
            const labels = { social_post: '📝 Social post created', email: '📧 Email sequence processed', ai_seo: '🔍 AI SEO content optimized', marketing_ideas: '💡 New marketing ideas generated', customer_research: '🧠 Customer research updated', schema_markup: '🏷️ Schema markup generated', lead_magnet: '🧲 Lead magnet created', community_post: '👥 Community post drafted' };
            return labels[t] || `✅ ${t}`;
          }).join('<br/>');
          const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
<h2 style="color:#667eea">Your AI worked overnight — ${biz.business_name}</h2>
<p>Hi ${biz.first_name || 'there'},</p>
<p>Here's what your AI marketing engine did today:</p>
<div style="background:#f8fafc;border-radius:12px;padding:16px;margin:12px 0">${taskList || 'No tasks needed today — everything is on track.'}</div>
${plan.top_insight ? `<p><strong>💡 Top insight:</strong> ${plan.top_insight}</p>` : ''}
${plan.tomorrow_plan ? `<p><strong>📅 Tomorrow's plan:</strong> ${plan.tomorrow_plan}</p>` : ''}
<p style="margin-top:20px"><a href="https://maroa-ai-marketing-automator.vercel.app/dashboard" style="background:#667eea;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">View Dashboard →</a></p>
<p style="color:#94a3b8;font-size:12px;margin-top:24px">This is your automated daily AI marketing report from maroa.ai</p></div>`;
          await sendEmail(biz.email, `Your AI did this overnight — ${biz.business_name}`, html);
        }
      } catch (emailErr) { log('/api/orchestrator/run', `Email report failed: ${emailErr.message}`); }

      log('/api/orchestrator/run', `✅ ${p.business_name}: ${executed.length} tasks + email report`);
    } catch (err) { console.error('[orchestrator]', err.message); }
  });
});

// Plan-based orchestrator scheduling:
// Starter: 1x/day (6am) | Growth: 3x/day (6am, 12pm, 6pm) | Agency: 5x/day (6am, 9am, 12pm, 3pm, 6pm)
function shouldRunOrchestrator(business, currentHour) {
  const plan = business.plan || 'starter';
  const runsToday = business.orchestrator_run_count_today || 0;

  if (plan === 'starter' || plan === 'free') {
    return currentHour === 6 && runsToday === 0;
  }
  if (plan === 'growth') {
    return [6, 12, 18].includes(currentHour) && runsToday < 3;
  }
  if (plan === 'agency') {
    return [6, 9, 12, 15, 18].includes(currentHour) && runsToday < 5;
  }
  return currentHour === 6 && runsToday === 0; // default: 1x
}

app.post('/api/orchestrator/run-all', async (req, res) => {
  // Security: require orchestrator secret
  const secret = req.headers['x-orchestrator-secret'];
  if (ORCHESTRATOR_SECRET && secret !== ORCHESTRATOR_SECRET) {
    return res.status(401).json({ error: 'unauthorized — invalid x-orchestrator-secret header' });
  }

  const currentHour = new Date().getUTCHours(); // Use UTC for consistency

  // Midnight reset: clear daily run counts
  if (currentHour === 0) {
    try {
      await sbPatch('businesses', 'id=not.is.null', { orchestrator_run_count_today: 0 });
      log('/api/orchestrator/run-all', 'Midnight reset — cleared all daily run counts');
    } catch (err) {
      log('/api/orchestrator/run-all', `Reset failed: ${err.message}`);
    }
  }

  res.json({ received: true, message: 'Running plan-based orchestration', hour: currentHour });
  setImmediate(async () => {
    let processed = 0;
    let skipped = 0;
    const byPlan = { starter: 0, growth: 0, agency: 0 };
    const errors = [];
    try {
      // Fetch all active businesses with plan and run count
      let users = [];
      try {
        users = await sbGet('businesses', 'onboarding_complete=eq.true&select=id,user_id,business_name,plan,orchestrator_run_count_today');
      } catch {
        try {
          users = await sbGet('business_profiles', 'business_name=not.is.null&select=user_id,business_name');
          users = users.map(u => ({ id: u.user_id, user_id: u.user_id, business_name: u.business_name, plan: 'starter', orchestrator_run_count_today: 0 }));
        } catch {
          users = await sbGet('businesses', 'is_active=eq.true&select=id,business_name,plan');
          users = users.map(u => ({ ...u, user_id: u.id, orchestrator_run_count_today: 0 }));
        }
      }
      log('/api/orchestrator/run-all', `Found ${users.length} active businesses, hour=${currentHour} UTC`);

      for (const u of users) {
        const uid = u.user_id || u.id;
        const plan = u.plan || 'starter';

        if (!shouldRunOrchestrator(u, currentHour)) {
          skipped++;
          continue;
        }

        try {
          await apiRequest('POST', `https://maroa-api-production.up.railway.app/api/orchestrator/run/${uid}`, { 'Content-Type': 'application/json' }, {});
          processed++;
          const planKey = ['starter', 'growth', 'agency'].includes(plan) ? plan : 'starter';
          byPlan[planKey]++;

          // Update run count
          try {
            await sbPatch('businesses', `id=eq.${u.id}`, {
              last_orchestrator_run: new Date().toISOString(),
              orchestrator_run_count_today: (u.orchestrator_run_count_today || 0) + 1
            });
          } catch {}

          log('/api/orchestrator/run-all', `${processed}: ${u.business_name || uid} [${plan}]`);
        } catch (err) {
          errors.push({ user: uid, plan, error: err.message });
        }
        await new Promise(r => setTimeout(r, 8000)); // 8s between users
      }
      log('/api/orchestrator/run-all', `✅ Done: ${processed} processed, ${skipped} skipped, ${errors.length} errors | starter:${byPlan.starter} growth:${byPlan.growth} agency:${byPlan.agency}`);
    } catch (err) {
      console.error('[orchestrator/run-all]', err.message);
      errors.push({ error: err.message });
    }
  });
});
app.get('/api/orchestrator/log/:userId', async (req, res) => {
  try { const r = await sbGet('orchestration_logs', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=10`); res.json({ logs: r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── n8n workflow route aliases (internal URL rewrite) ───────────────────────
// WF32 calls /api/social/linkedin/publish instead of /webhook/linkedin-publish
app.post('/api/social/linkedin/publish', (req, res) => {
  req.url = '/webhook/linkedin-publish';
  app.handle(req, res);
});
// WF33 calls /api/social/twitter/tweet and /api/social/twitter/thread
app.post('/api/social/twitter/tweet', (req, res) => {
  req.url = '/webhook/twitter-publish';
  app.handle(req, res);
});
app.post('/api/social/twitter/thread', (req, res) => {
  req.body.post_type = 'thread';
  req.url = '/webhook/twitter-publish';
  app.handle(req, res);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING v2 — Structured Business Profiles
// ═══════════════════════════════════════════════════════════════════════════════

const { buildMasterPrompt, buildMasterPromptWithSkills, calculateProfileScore, getMissingFields, validateBeforeGeneration } = require('./services/masterPromptBuilder');
const { buildAndStorePineconeProfile } = require('./services/pineconeProfileBuilder');

// ─── POST /api/onboarding/save ─ Full profile upsert ────────────────────────
app.post('/api/onboarding/save', async (req, res) => {
  try {
    const data = req.body;
    // Validate required fields
    const required = ['business_name', 'business_type', 'primary_language', 'primary_goal', 'monthly_budget'];
    const missingRequired = required.filter(f => !data[f]);
    const locs = Array.isArray(data.physical_locations) ? data.physical_locations : [];
    if (locs.length === 0 || !locs[0]?.city) missingRequired.push('physical_locations');
    if (missingRequired.length > 0) {
      return res.status(400).json({ error: 'missing_required', missing: missingRequired });
    }

    const userId = data.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    // Calculate profile score
    const profile_score = calculateProfileScore(data);

    // Build payload for Supabase (only known columns)
    const profilePayload = {
      user_id: userId,
      business_name: data.business_name,
      business_type: data.business_type,
      business_age: data.business_age || null,
      usp: data.usp || null,
      tagline: data.tagline || null,
      physical_locations: data.physical_locations || [],
      operation_model: data.operation_model || null,
      service_area: data.service_area || [],
      ad_targeting_area: data.ad_targeting_area || [],
      primary_language: data.primary_language || 'English',
      secondary_languages: data.secondary_languages || [],
      audience_age_min: data.audience_age_min || 18,
      audience_age_max: data.audience_age_max || 65,
      audience_gender: data.audience_gender || 'mixed',
      audience_description: data.audience_description || null,
      pain_point: data.pain_point || null,
      avg_spend: data.avg_spend || null,
      products: data.products || [],
      current_offer: data.current_offer || null,
      primary_goal: data.primary_goal,
      monthly_budget: data.monthly_budget,
      ads_experience: data.ads_experience || null,
      tone_keywords: data.tone_keywords || [],
      never_do: data.never_do || null,
      business_hours: data.business_hours || {},
      seasonal: data.seasonal || 'year_round',
      busy_months: data.busy_months || [],
      best_posting_times: data.best_posting_times || 'auto',
      competitors: data.competitors || [],
      they_do_better: data.they_do_better || null,
      we_do_better: data.we_do_better || null,
      profile_score,
      updated_at: new Date().toISOString()
    };

    // Upsert: check if profile exists
    const existing = await sbGet('business_profiles', `user_id=eq.${userId}&select=id`).catch(() => []);
    if (existing.length > 0) {
      await sbPatch('business_profiles', `user_id=eq.${userId}`, profilePayload);
    } else {
      await sbPost('business_profiles', profilePayload);
    }

    // Also update core fields in businesses table (keeps both tables in sync)
    try {
      const bizUpdate = {};
      if (data.business_name) bizUpdate.business_name = data.business_name;
      if (data.business_type) bizUpdate.industry = data.business_type;
      if (locs[0]?.city) bizUpdate.location = locs[0].city;
      if (data.audience_description) bizUpdate.target_audience = data.audience_description;
      if (data.primary_goal) bizUpdate.marketing_goal = data.primary_goal;
      if (data.tone_keywords?.[0]) bizUpdate.brand_tone = data.tone_keywords[0];
      if (data.monthly_budget) {
        const num = parseInt(String(data.monthly_budget).replace(/[^0-9]/g, ''));
        if (num > 0) bizUpdate.daily_budget = Math.round(num / 30);
      }
      if (Object.keys(bizUpdate).length > 0) {
        await sbPatch('businesses', `id=eq.${userId}`, bizUpdate).catch(() =>
          sbPatch('businesses', `user_id=eq.${userId}`, bizUpdate).catch(() => {})
        );
      }
    } catch {}

    // Store in Pinecone (non-blocking — don't fail the request)
    buildAndStorePineconeProfile(userId, profilePayload, getEmbedding, pineconeUpsert)
      .catch(err => console.warn('Pinecone profile store failed (non-critical):', err.message));

    const missing = getMissingFields(profilePayload);
    res.json({ success: true, profile_score, missing_fields: missing });
  } catch (err) {
    console.error('Onboarding save error:', err);
    res.status(500).json({ error: err.message || 'Failed to save profile' });
  }
});

// ─── GET /api/onboarding/profile/:userId ─ Fetch profile (checks BOTH tables)
app.get('/api/onboarding/profile/:userId', async (req, res) => {
  const uid = req.params.userId;
  try {
    // Try business_profiles first (detailed onboarding data)
    let profile = null;
    try { const r = await sbGet('business_profiles', `user_id=eq.${uid}&select=*`); profile = r[0] || null; } catch {}

    // Also fetch from businesses table (core data)
    let biz = null;
    try {
      let r = await sbGet('businesses', `id=eq.${uid}&select=*`);
      if (!r.length) r = await sbGet('businesses', `user_id=eq.${uid}&select=*`);
      biz = r[0] || null;
    } catch {}

    if (!profile && !biz) return res.status(404).json({ error: 'Profile not found' });

    // Merge: business_profiles data takes priority, businesses fills gaps
    const merged = { ...(profile || {}) };
    if (biz) {
      if (!merged.business_name) merged.business_name = biz.business_name;
      if (!merged.business_type) merged.business_type = biz.industry;
      if (!merged.primary_language) merged.primary_language = 'Albanian';
      if (!merged.audience_description) merged.audience_description = biz.target_audience;
      if (!merged.primary_goal) merged.primary_goal = biz.marketing_goal;
      if ((!merged.physical_locations || !merged.physical_locations.length) && biz.location) {
        merged.physical_locations = [{ city: biz.location }];
      }
      if (!merged.monthly_budget && biz.daily_budget) merged.monthly_budget = '€' + (biz.daily_budget * 30);
      if ((!merged.tone_keywords || !merged.tone_keywords.length) && biz.brand_tone) merged.tone_keywords = [biz.brand_tone];
      // Include useful businesses-only fields
      merged.email = merged.email || biz.email;
      merged.plan = merged.plan || biz.plan;
      merged.meta_access_token = merged.meta_access_token || biz.meta_access_token;
      merged.facebook_page_id = merged.facebook_page_id || biz.facebook_page_id;
      merged._source = profile ? 'business_profiles' : 'businesses';
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/context/:userId — Full onboarding + intelligence for n8n / Claude ─
function contextAsArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function contextParseThemeList(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try {
    const j = JSON.parse(v);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function contextSelectedPlatforms(biz) {
  if (!biz?.selected_platforms) return [];
  try {
    const j = JSON.parse(biz.selected_platforms);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function resolveContextEntities(paramId) {
  let biz = null;
  try {
    let r = await sbGet('businesses', `id=eq.${paramId}&select=*`);
    if (!r.length) r = await sbGet('businesses', `user_id=eq.${paramId}&select=*`);
    biz = r[0] || null;
  } catch {}
  let profile = null;
  try {
    const pr = await sbGet('business_profiles', `user_id=eq.${paramId}&select=*`);
    profile = pr[0] || null;
  } catch {}
  if (!profile && biz?.user_id) {
    try {
      const pr = await sbGet('business_profiles', `user_id=eq.${biz.user_id}&select=*`);
      profile = pr[0] || null;
    } catch {}
  }
  if (!profile && biz?.id) {
    try {
      const pr = await sbGet('business_profiles', `user_id=eq.${biz.id}&select=*`);
      profile = pr[0] || null;
    } catch {}
  }
  const businessId = biz?.id || null;
  const contextUserId = profile?.user_id || biz?.user_id || biz?.id || paramId;
  return { profile, biz, businessId, contextUserId };
}

function mergeProfileForMasterPrompt(profile, biz, contextUserId) {
  const m = {};
  if (biz) Object.assign(m, biz);
  if (profile) Object.assign(m, profile);
  m.user_id = profile?.user_id || contextUserId;
  if (!m.business_type && biz?.industry) m.business_type = biz.industry;
  if (!m.business_name && biz?.business_name) m.business_name = biz.business_name;
  if (!m.primary_goal && biz?.marketing_goal) m.primary_goal = biz.marketing_goal;
  if (!m.audience_description && biz?.target_audience) m.audience_description = biz.target_audience;
  if (!m.monthly_budget && biz?.daily_budget) m.monthly_budget = '€' + (biz.daily_budget * 30);
  if ((!m.physical_locations || !m.physical_locations.length) && biz?.location) m.physical_locations = [{ city: biz.location }];
  if ((!m.tone_keywords || !m.tone_keywords.length) && biz?.brand_tone) m.tone_keywords = [biz.brand_tone];
  if (!m.usp && biz?.unique_differentiator) m.usp = biz.unique_differentiator;
  return m;
}

app.get('/api/context/:userId', async (req, res) => {
  const paramId = req.params.userId;
  const rawTask = (req.query.task_type || req.query.taskType || 'general').toString().toLowerCase();
  const allowedTasks = new Set(['social_post', 'paid_ad', 'email', 'sms', 'image', 'content_calendar', 'general']);
  const taskType = allowedTasks.has(rawTask) ? rawTask : 'general';

  try {
    const { profile, biz, businessId, contextUserId } = await resolveContextEntities(paramId);
    if (!profile && !biz) return res.status(404).json({ error: 'Profile or business not found' });

    const mergedForPrompt = mergeProfileForMasterPrompt(profile, biz, contextUserId);
    const p = profile || {};
    const b = biz || {};
    const arr = contextAsArray;

    const [intelRows, ideas, perfSnaps, topContent] = await Promise.all([
      getAllIntelligence(contextUserId).catch(() => []),
      sbGet('marketing_ideas', `user_id=eq.${contextUserId}&order=created_at.desc&limit=30`).catch(() => []),
      businessId
        ? sbGet('content_performance', `business_id=eq.${businessId}&order=recorded_at.desc&limit=100`).catch(() => [])
        : Promise.resolve([]),
      businessId
        ? sbGet(
            'generated_content',
            `business_id=eq.${businessId}&order=performance_score.desc&limit=15&select=id,content_theme,performance_score,status,created_at,published_at`
          ).catch(() => [])
        : Promise.resolve([]),
    ]);

    const memoryContextStr = (await getMemoryContext(contextUserId).catch(() => '')) || '';
    const perfThemesExtra = businessId ? await fetchPerformanceThemesContextBlock(businessId) : '';

    let full_master_prompt = '';
    try {
      full_master_prompt = await getCachedMasterPrompt(
        String(contextUserId),
        mergedForPrompt,
        taskType,
        perfThemesExtra || ''
      );
    } catch (e) {
      try {
        full_master_prompt = buildMasterPrompt(mergedForPrompt, taskType) + (perfThemesExtra ? `\n\n${perfThemesExtra}\n` : '');
      } catch {
        full_master_prompt = perfThemesExtra || '';
      }
    }

    const locs = arr(p.physical_locations);
    const socialPlats = arr(p.social_platforms);
    const activePlats = arr(p.active_platforms);
    const socialFromBiz = contextSelectedPlatforms(biz);
    const painFromBiz = b.customer_pain_points
      ? String(b.customer_pain_points)
          .split(/[,;\n]/)
          .map(s => s.trim())
          .filter(Boolean)
      : [];

    const body = {
      business_name: p.business_name || b.business_name || null,
      business_type: p.business_type || b.industry || null,
      business_description: p.business_description ?? b.business_description ?? null,
      business_stage: p.business_stage ?? p.business_age ?? null,
      tagline: p.tagline ?? null,
      usp: p.usp ?? b.unique_differentiator ?? null,
      brand_values: arr(p.brand_values),

      physical_locations: locs.length ? locs : (b.location ? [{ city: b.location }] : []),
      country: p.country ?? null,
      city: locs[0]?.city || b.location || b.city || null,
      operation_model: p.operation_model ?? null,
      service_area: arr(p.service_area),
      ad_targeting_area: arr(p.ad_targeting_area),

      audience_age_min: p.audience_age_min ?? null,
      audience_age_max: p.audience_age_max ?? null,
      audience_gender: p.audience_gender ?? null,
      audience_description: p.audience_description ?? b.target_audience ?? null,
      pain_points: arr(p.pain_points).length ? arr(p.pain_points) : (p.pain_point ? [p.pain_point] : painFromBiz),
      desired_outcome: p.desired_outcome ?? null,
      customer_language: p.customer_language ?? null,
      objections: arr(p.objections),

      products: arr(p.products),
      current_offer: p.current_offer ?? null,
      seasonal_offers: p.seasonal_offers ?? p.seasonal ?? null,

      primary_goal: p.primary_goal ?? b.marketing_goal ?? null,
      secondary_goal: p.secondary_goal ?? null,
      monthly_budget: p.monthly_budget ?? (b.daily_budget ? '€' + b.daily_budget * 30 : null),
      marketing_experience: p.marketing_experience ?? p.ads_experience ?? null,

      tone_keywords: arr(p.tone_keywords).length ? arr(p.tone_keywords) : (b.brand_tone ? [b.brand_tone] : []),
      brand_personality: arr(p.brand_personality),
      formality_level: p.formality_level ?? p.language_formality ?? null,
      emoji_usage: p.emoji_usage ?? null,
      words_always_use: arr(p.words_always_use),
      words_never_use: arr(p.words_never_use).length ? arr(p.words_never_use) : (p.never_do ? [p.never_do] : []),
      primary_language: p.primary_language ?? b.primary_language ?? 'English',
      content_language: p.content_language ?? p.primary_language ?? 'English',

      social_platforms: socialPlats.length ? socialPlats : (activePlats.length ? activePlats : socialFromBiz),
      primary_platform: p.primary_platform ?? null,
      posting_frequency: p.posting_frequency ?? p.posting_frequency_goal ?? p.best_posting_times ?? null,
      content_mix: p.content_mix && typeof p.content_mix === 'object' && !Array.isArray(p.content_mix) ? p.content_mix : {},

      competitors: arr(p.competitors),
      competitive_advantage: p.competitive_advantage ?? p.we_do_better ?? p.why_customers_choose_us ?? null,

      business_hours: p.business_hours && typeof p.business_hours === 'object' && !Array.isArray(p.business_hours) ? p.business_hours : {},
      busiest_days: arr(p.busiest_days),
      quietest_days: arr(p.quietest_days),
      staff_count: p.staff_count ?? null,

      brand_colors: arr(p.brand_colors),
      visual_style: p.visual_style ?? null,
      photo_style: p.photo_style ?? null,

      has_email_list: p.has_email_list ?? null,
      email_list_size: p.email_list_size ?? null,
      has_whatsapp: p.has_whatsapp ?? null,
      collects_reviews: p.collects_reviews ?? null,
      review_platforms: arr(p.review_platforms),

      approval_mode: p.approval_mode ?? null,
      auto_publish_platforms: arr(p.auto_publish_platforms),
      content_frequency: p.content_frequency ?? null,
      preferred_post_times: arr(p.preferred_post_times).length
        ? arr(p.preferred_post_times)
        : (p.best_posting_time ? [p.best_posting_time] : []),

      intelligence_signals: intelRows,
      best_performing_themes: contextParseThemeList(b.best_performing_themes || p.best_performing_themes),
      worst_performing_themes: contextParseThemeList(b.worst_performing_themes || p.worst_performing_themes),
      memory_context: memoryContextStr,

      plan: b.plan ?? p.plan ?? null,
      email: b.email ?? p.email ?? null,
      created_at: b.created_at ?? null,

      marketing_ideas: ideas,
      performance_metrics: {
        content_performance_snapshots: perfSnaps,
        top_generated_content: topContent,
      },

      full_master_prompt: full_master_prompt,
    };

    if (profile) body.profile_raw = profile;
    if (biz) {
      body.business_core = {
        id: biz.id,
        user_id: biz.user_id,
        plan: biz.plan,
        email: biz.email,
        created_at: biz.created_at,
      };
    }
    body.context_user_id = contextUserId;
    body.task_type_used = taskType;

    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load context' });
  }
});

// ─── PATCH /api/onboarding/profile/:userId ─ Partial update ─────────────────
app.patch('/api/onboarding/profile/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const updates = req.body;
    delete updates.user_id; // prevent changing ownership
    delete updates.id;

    // Apply update
    await sbPatch('business_profiles', `user_id=eq.${userId}`, { ...updates, updated_at: new Date().toISOString() });

    // Recalculate score from full profile
    const rows = await sbGet('business_profiles', `user_id=eq.${userId}&select=*`);
    if (rows[0]) {
      const newScore = calculateProfileScore(rows[0]);
      await sbPatch('business_profiles', `user_id=eq.${userId}`, { profile_score: newScore });
      const missing = getMissingFields(rows[0]);
      res.json({ success: true, profile_score: newScore, missing_fields: missing });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/onboarding/score/:userId ─ Profile completeness scoring ───────
app.get('/api/onboarding/score/:userId', async (req, res) => {
  try {
    const rows = await sbGet('business_profiles', `user_id=eq.${req.params.userId}&select=*`);
    const profile = rows[0];
    const score = profile ? calculateProfileScore(profile) : 0;
    const missing = profile ? getMissingFields(profile) : ['all'];

    const thresholds = {
      social_posts: { required: 30, unlocked: score >= 30 },
      email_sms: { required: 50, unlocked: score >= 50 },
      paid_ads: { required: 70, unlocked: score >= 70 },
      full_autopilot: { required: 90, unlocked: score >= 90 },
      premium_accuracy: { required: 100, unlocked: score >= 100 },
    };

    const unlocked = Object.entries(thresholds).filter(([, v]) => v.unlocked).map(([k]) => k);
    const locked = Object.entries(thresholds).filter(([, v]) => !v.unlocked).map(([k]) => k);
    const nextUnlock = locked[0] || null;

    // Figure out what's missing for next unlock
    const missingForNext = [];
    if (nextUnlock) {
      if (score < 30) missingForNext.push('business_name', 'business_type', 'physical_locations', 'primary_language');
      else if (score < 50) missingForNext.push('audience_description', 'pain_point', 'products');
      else if (score < 70) missingForNext.push('primary_goal', 'monthly_budget', 'ad_targeting_area');
      else if (score < 90) missingForNext.push('tone_keywords', 'never_do', 'business_hours', 'competitors');
      else missingForNext.push(...missing);
    }

    res.json({
      score,
      unlocked,
      locked,
      next_unlock: nextUnlock,
      missing_for_next: missingForNext.filter(m => missing.includes(m)),
      thresholds
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Chat Assistant (streaming) ───────────────────────────────────────────
app.post('/webhook/ai-chat', async (req, res) => {
  try {
    const { message, business_id } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    let bizCtx = 'Business context not available';
    try {
      const p = await getProfile(business_id);
      if (p) bizCtx = `Business: ${p.business_name}, Type: ${p.business_type}, City: ${pCity(p)}, Language: ${p.primary_language || 'English'}, Goal: ${p.primary_goal || 'grow'}, USP: ${p.usp || ''}`;
    } catch {}

    const systemPrompt = `You are an expert AI marketing assistant for maroa.ai. Help small business owners with marketing strategy, content ideas, and growth. ${bizCtx}. Be concise, practical, and specific. Respond in the same language the user writes in.`;

    // Stream via raw HTTPS to Anthropic
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const bodyStr = JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 1024, stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });

    const streamReq = https.request({
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, (streamRes) => {
      let buffer = '';
      streamRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                res.write(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`);
              }
            } catch {}
          }
        }
      });
      streamRes.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
      streamRes.on('error', () => {
        res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
        res.end();
      });
    });

    streamReq.on('error', (err) => {
      console.error('AI chat stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Chat failed' })}\n\n`);
      res.end();
    });

    streamReq.write(bodyStr);
    streamReq.end();
  } catch (err) {
    console.error('AI chat error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Chat failed' });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
  }
});

// ─── Waitlist Registration ────────────────────────────────────────────────────
app.post('/api/waitlist/register', validate('waitlist'), async (req, res) => {
  const { name, email, plan, business_type, country } = req.validatedBody;

  try {
    await sbPost('waitlist', { name, email, plan: plan || null, business_type: business_type || null, country: country || null });
  } catch (err) {
    if (err.message && err.message.includes('23505')) return apiError(res, 409, 'CONFLICT', 'Email already registered');
    return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
  }

  // Confirmation email to user
  const userHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
<h2 style="color:#667eea">You're on the maroa.ai waitlist! 🚀</h2>
<p>Hi ${name},</p>
<p>You're officially on the maroa.ai early access list!</p>
<p><strong>Your pre-launch price is locked:</strong></p>
<table style="border-collapse:collapse;margin:12px 0;font-size:14px">
<tr><td style="padding:6px 16px 6px 0">Starter</td><td style="padding:6px 0"><strong>€19/mo</strong> <span style="text-decoration:line-through;color:#94a3b8">€29</span></td></tr>
<tr><td style="padding:6px 16px 6px 0">Growth</td><td style="padding:6px 0"><strong>€39/mo</strong> <span style="text-decoration:line-through;color:#94a3b8">€69</span></td></tr>
<tr><td style="padding:6px 16px 6px 0">Agency</td><td style="padding:6px 0"><strong>€79/mo</strong> <span style="text-decoration:line-through;color:#94a3b8">€149</span></td></tr>
</table>
<p>We launch <strong>April 28, 2026</strong>. You'll be the first to know.</p>
<p>Your <strong>1 week free trial</strong> starts automatically on launch day.</p>
<p style="margin-top:20px">See you on April 28! 🚀<br/>— The maroa.ai team</p>
</div>`;
  sendEmail(email, "You're on the maroa.ai waitlist! 🚀", userHtml).catch(() => {});

  // Notification to admin
  sendEmail('idealbekteshi06@gmail.com', `New waitlist signup: ${name} — ${plan || 'no plan'}`,
    `<p><strong>New waitlist registration</strong></p><p>Name: ${name}<br/>Email: ${email}<br/>Plan: ${plan || 'not selected'}<br/>Business type: ${business_type || 'not specified'}<br/>Country: ${country || 'not specified'}<br/>Time: ${new Date().toISOString()}</p>`
  ).catch(() => {});

  res.json({ success: true, message: 'Welcome to the waitlist!' });
});

app.get('/api/waitlist/count', async (req, res) => {
  try {
    const rows = await sbGet('waitlist', 'select=id');
    res.json({ count: rows.length });
  } catch (err) { res.json({ count: 0 }); }
});

// ─── POST /api/generate — Plan-gated generation with usage tracking ─────────
const GENERATE_MODELS = {
  generate_image:       { model_used: 'higgsfield-soul',     credits_used: 3  },
  generate_video_kling: { model_used: 'kling-3.0',           credits_used: 6  },
  generate_video_sora:  { model_used: 'sora-2',              credits_used: 50 },
  process_product:      { model_used: 'product-catalog',     credits_used: 10 },
  score_content:        { model_used: 'claude-vision-score', credits_used: 1 },
  generate_caption:     { model_used: 'claude-caption',      credits_used: 1 }
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
      prompt
    } = req.body;

    let extra = {};

    if (action === 'process_product') {
      const imgs = Array.isArray(product_image_urls) && product_image_urls.length
        ? product_image_urls
        : (product_image_url ? [product_image_url] : []);
      if (!imgs.length) return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_urls or product_image_url required');
      const [imgU, kU, sU] = await Promise.all([
        monthlyUsageCount(user_id, 'generate_image'),
        monthlyUsageCount(user_id, 'generate_video_kling'),
        monthlyUsageCount(user_id, 'generate_video_sora')
      ]);
      const L = req.planLimits || {};
      const remaining = {
        images: Math.max(0, (L.images || 0) - imgU),
        kling: Math.max(0, (L.kling || 0) - kU),
        sora: Math.max(0, (L.sora || 0) - sU)
      };
      extra = await higgsfieldAI.processProductCatalog(user_id, business_id || user_id, imgs, brand_dna || {}, {
        plan: req.userPlan,
        planLimits: L,
        remaining
      });
    } else if (action === 'generate_image') {
      if (!product_image_url) return apiError(res, 400, 'VALIDATION_ERROR', 'product_image_url required');
      extra = {
        image_urls: await higgsfieldAI.generateProductImage(product_image_url, brand_dna || {}, {
          prompt: typeof prompt === 'string' ? prompt : undefined,
          userId: user_id
        })
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
      status: 'success'
    }).catch(() => {});

    res.json({ success: true, action, plan: req.userPlan, model_used: model.model_used, credits_used: model.credits_used, ...extra });
  } catch (err) {
    logger.error('/api/generate', req.body?.user_id, 'Generate failed', err);
    try {
      await sbPost('usage_logs', {
        user_id: req.body?.user_id,
        action: req.body?.action,
        plan_name: req.userPlan || 'unknown',
        model_used: 'error',
        credits_used: 0,
        status: 'failed'
      }).catch(() => {});
    } catch { /* ignore */ }
    const httpStatus = err && typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    apiError(res, httpStatus, (typeof err.code === 'string' && err.code) ? err.code : 'GENERATE_ERROR', err.message || 'Generate failed');
  }
});

// ─── Workflow #1 routes (Daily Content Engine) ──────────────────────────────
// Registered after legacy routes so WF1 takes precedence on its wf1-* paths.
registerWf1Routes({ app, wf1, sbGet, sbPost, sbPatch, apiError, logger });

// ─── In-process WF1 daily scheduler (opt-in via WF1_INTERNAL_CRON=true) ─────
if (process.env.WF1_INTERNAL_CRON === 'true') {
  // Every 15 min: check all active businesses, run for any whose local time is 06:xx
  const CRON_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    wf1.dailyRun.runForAllBusinesses({ force: false })
      .then(r => { if (r.processed > 0) logger.info('/wf1/internal-cron', null, 'daily sweep', { processed: r.processed }); })
      .catch(e => logger.error('/wf1/internal-cron', null, 'daily sweep failed', e));
  }, CRON_INTERVAL_MS);

  // Every 30 min: sweep 48h-due posts for learning loop + hybrid fallbacks
  const MEASURE_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(() => {
    Promise.all([
      wf1.learningLoop.sweepDuePosts({ limit: 25 }),
      wf1.dailyRun.processHybridFallbacks(),
    ])
      .then(([m, h]) => {
        if (m.measured > 0 || h.processed > 0)
          logger.info('/wf1/internal-cron', null, 'measure + fallback', { measured: m.measured, fallbacks: h.processed });
      })
      .catch(e => logger.error('/wf1/internal-cron', null, 'measure/fallback failed', e));
  }, MEASURE_INTERVAL_MS);

  logger.info('/wf1/internal-cron', null, 'in-process cron enabled', {
    daily_interval_ms: CRON_INTERVAL_MS,
    measure_interval_ms: MEASURE_INTERVAL_MS,
  });
}

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => apiError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));

app.use((err, req, res, next) => {
  logger.error(req.path || 'unknown', null, 'Unhandled error', err, { request_id: req.requestId });
  if (res.headersSent) return next(err);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const code = typeof err.code === 'string' && err.code ? err.code : 'INTERNAL_ERROR';
  const msg = process.env.NODE_ENV === 'production' && status >= 500 ? 'Internal server error' : (err.message || 'Internal server error');
  return apiError(res, status, code, msg);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Maroa.ai API v2.0 — port :${PORT}`);
  console.log(`  Layer 1: Execution ✓  Layer 2: Intelligence ✓  Layer 3: Learning ✓`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

function gracefulShutdown(signal) {
  log('shutdown', `Received ${signal}, closing server`);
  server.close(() => {
    log('shutdown', 'HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log('shutdown', 'Forced exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
