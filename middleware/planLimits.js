'use strict';
const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zqhyrbttuqkvmdewiytf.supabase.co').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

const PLAN_LIMITS = {
  starter: { images: 20,  kling: 0,  sora: 0,  video: false },
  growth:  { images: 60,  kling: 25, sora: 5,  video: true  },
  agency:  { images: 120, kling: 50, sora: 15, video: true  }
};

function sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Supabase request timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function checkPlanLimit(req, res, next) {
  try {
    const { user_id, action } = req.body;

    if (!user_id) return res.status(400).json({ error: 'missing_user_id', message: 'user_id is required' });
    if (!action)  return res.status(400).json({ error: 'missing_action', message: 'action is required' });

    // Get user's active plan from businesses table (plan column)
    const subRes = await sbRequest('GET', `/rest/v1/businesses?select=plan&id=eq.${user_id}`);
    const rows = Array.isArray(subRes.body) ? subRes.body : [];
    const plan = rows[0]?.plan || 'starter';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

    // Block video on starter
    if ((action === 'generate_video' || action === 'generate_video_kling' || action === 'generate_video_sora') && !limits.video) {
      return res.status(403).json({
        error: 'upgrade_required',
        message: 'Video generation requires Growth or Agency plan.',
        upgrade_url: 'https://maroa.ai/pricing'
      });
    }

    // Count this month's usage
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const countRes = await sbRequest('GET',
      `/rest/v1/usage_logs?select=id&user_id=eq.${user_id}&action=eq.${action}&created_at=gte.${monthStart}`,
    );
    const count = Array.isArray(countRes.body) ? countRes.body.length : 0;

    const limitKey = action === 'generate_image' ? 'images'
      : action === 'generate_video_kling' ? 'kling'
      : action === 'generate_video_sora' ? 'sora'
      : null;

    if (limitKey && limits[limitKey] !== undefined && count >= limits[limitKey]) {
      return res.status(429).json({
        error: 'limit_reached',
        message: `Monthly ${limitKey} limit reached for ${plan} plan (${limits[limitKey]}).`,
        current: count,
        limit: limits[limitKey],
        upgrade_url: 'https://maroa.ai/pricing'
      });
    }

    req.userPlan = plan;
    req.planLimits = limits;
    next();
  } catch (err) {
    console.error('[planLimits] Error:', err.message);
    // Fail open — don't block users if plan check fails
    req.userPlan = 'starter';
    req.planLimits = PLAN_LIMITS.starter;
    next();
  }
}

module.exports = { checkPlanLimit, PLAN_LIMITS };
