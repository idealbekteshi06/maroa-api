'use strict';
const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

const PLAN_LIMITS = {
  starter: { images: 20, kling: 0, sora: 0, scores: 2000, captions: 2000, process_product: 20, video: false },
  growth: { images: 60, kling: 25, sora: 0, scores: 8000, captions: 8000, process_product: 60, video: true },
  agency: { images: 120, kling: 50, sora: 15, scores: 20000, captions: 20000, process_product: 120, video: true },
};

// Whitelist of action enums. Anything outside this set is rejected before
// hitting Supabase — prevents enum injection where a crafted action like
// `generate_image&order=...` would alter the query.
const VALID_ACTIONS = new Set([
  'generate_image',
  'generate_video',
  'generate_video_kling',
  'generate_video_sora',
  'score_content',
  'generate_caption',
  'process_product',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

function normalizePlan(raw) {
  const p = (raw || 'starter').toLowerCase();
  if (p === 'free') return 'starter';
  if (PLAN_LIMITS[p]) return p;
  return 'starter';
}

function isValidAction(action) {
  return VALID_ACTIONS.has(action);
}

function limitKeyForAction(action) {
  switch (action) {
    case 'generate_image':
      return 'images';
    case 'generate_video_kling':
      return 'kling';
    case 'generate_video_sora':
      return 'sora';
    case 'score_content':
      return 'scores';
    case 'generate_caption':
      return 'captions';
    case 'process_product':
      return 'process_product';
    default:
      return null;
  }
}

// Pure quota decision — no I/O, unit-testable. Given the (raw) plan, the action,
// and the current month's usage count for that action, decide allow/deny.
function decidePlanLimit({ plan, action, count }) {
  const normPlan = normalizePlan(plan);
  const limits = PLAN_LIMITS[normPlan] || PLAN_LIMITS.starter;
  const isVideo = action === 'generate_video' || action === 'generate_video_kling' || action === 'generate_video_sora';
  if (isVideo && !limits.video) {
    return { allowed: false, reason: 'upgrade_required', plan: normPlan };
  }
  const limitKey = limitKeyForAction(action);
  const limit = limitKey ? limits[limitKey] : undefined;
  if (limitKey && limit !== undefined && Number(count) >= limit) {
    return { allowed: false, reason: 'limit_reached', plan: normPlan, limitKey, limit, current: Number(count) };
  }
  return { allowed: true, plan: normPlan, limitKey, limit };
}

function sbRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        // Surface the Content-Range header (PostgREST puts the count
        // there when Prefer: count=exact is used) so callers can read it
        // without parsing the body.
        const contentRange = res.headers?.['content-range'] || res.headers?.['Content-Range'] || null;
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), contentRange });
        } catch {
          resolve({ status: res.statusCode, body: data, contentRange });
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Supabase request timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sbCountExact(table, queryWithoutSelect) {
  return new Promise((resolve, reject) => {
    const path = `/rest/v1/${table}?${queryWithoutSelect}&select=id`;
    const url = new URL(SUPABASE_URL + path);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'count=exact',
        },
      },
      (res) => {
        res.resume();
        const cr = res.headers['content-range'];
        const m = typeof cr === 'string' && cr.match(/\/(\d+)\s*$/);
        resolve(m ? parseInt(m[1], 10) : 0);
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('Supabase request timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Parse PostgREST's Content-Range header. Format: "0-9/47" or "*/0".
// Returns the integer count, or null if unparseable.
function parseContentRangeCount(contentRange) {
  if (!contentRange) return null;
  const match = /\/(\d+)$/.exec(String(contentRange));
  return match ? Number(match[1]) : null;
}

async function checkPlanLimit(req, res, next) {
  try {
    let { user_id, action } = req.body;
    if (action === 'generate_video') action = 'generate_video_kling';
    req.body.action = action;

    if (!user_id) return res.status(400).json({ error: 'missing_user_id', message: 'user_id is required' });
    if (!action) return res.status(400).json({ error: 'missing_action', message: 'action is required' });

    // Strict validation BEFORE interpolating into PostgREST filter. Both
    // values were previously concatenated raw, allowing query-shape attacks
    // via crafted user_id/action values.
    if (!isUuid(user_id)) {
      return res.status(400).json({ error: 'invalid_user_id', message: 'user_id must be a valid UUID' });
    }
    if (!VALID_ACTIONS.has(action)) {
      return res
        .status(400)
        .json({ error: 'invalid_action', message: `action must be one of: ${[...VALID_ACTIONS].join(', ')}` });
    }
    const safeUserId = encodeURIComponent(user_id);
    const safeAction = encodeURIComponent(action);

    const subRes = await sbRequest('GET', `/rest/v1/businesses?select=plan&id=eq.${safeUserId}`);
    const rows = Array.isArray(subRes.body) ? subRes.body : [];
    const plan = normalizePlan(rows[0]?.plan);
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    // SECURITY/PERFORMANCE: HEAD request + Prefer: count=exact (PostgREST returns
    // the count in the Content-Range header without sending rows — bounded memory).
    const count = await sbCountExact(
      'usage_logs',
      `user_id=eq.${safeUserId}&action=eq.${safeAction}&created_at=gte.${encodeURIComponent(monthStart)}`
    ).catch(() => 0);

    // Pure decision (unit-tested in tests/plan-limits.test.js).
    const decision = decidePlanLimit({ plan, action, count });
    if (!decision.allowed && decision.reason === 'upgrade_required') {
      return res.status(403).json({
        error: 'upgrade_required',
        message: 'Video generation requires Growth or Agency plan.',
        upgrade_url: 'https://maroa.ai/pricing',
      });
    }
    if (!decision.allowed && decision.reason === 'limit_reached') {
      return res.status(429).json({
        error: 'limit_reached',
        message: `Monthly ${decision.limitKey} limit reached for ${plan} plan (${decision.limit}).`,
        current: decision.current,
        limit: decision.limit,
        upgrade_url: 'https://maroa.ai/pricing',
      });
    }

    req.userPlan = plan;
    req.planLimits = limits;
    next();
  } catch (err) {
    console.error('[planLimits] Error:', err.message);
    req.userPlan = 'starter';
    req.planLimits = PLAN_LIMITS.starter;
    next();
  }
}

module.exports = {
  checkPlanLimit,
  PLAN_LIMITS,
  normalizePlan,
  decidePlanLimit,
  isValidAction,
  limitKeyForAction,
  VALID_ACTIONS,
};
