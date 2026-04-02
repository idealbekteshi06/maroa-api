// server.js — Maroa.ai Webhook API Server v2.0
// Layer 1: Execution  | Layer 2: Intelligence  | Layer 3: Learning
// The AI does everything forever and gets smarter every week.

'use strict';
const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const http     = require('http');
const planGate = require('./middleware/planGate');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://maroa-ai-marketing-automator.lovable.app',
    'https://maroa.ai',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey'],
  credentials: true
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// ─── Config ───────────────────────────────────────────────────────────────────
const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL        = clean(process.env.SUPABASE_URL)        || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_KEY        = clean(process.env.SUPABASE_KEY)        || '';
const ANTHROPIC_KEY       = clean(process.env.ANTHROPIC_KEY)       || '';
const SERPAPI_KEY         = clean(process.env.SERPAPI_KEY)         || '';
const REPLICATE_API_KEY   = clean(process.env.REPLICATE_API_KEY)   || '';
const PEXELS_API_KEY      = clean(process.env.PEXELS_API_KEY)      || '';
const RESEND_API_KEY      = clean(process.env.RESEND_API_KEY)      || '';
const FROM_EMAIL          = clean(process.env.FROM_EMAIL)          || 'onboarding@resend.dev';
const PORT                = process.env.PORT                        || 3000;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function apiRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u        = new URL(url);
    const bodyStr  = body ? JSON.stringify(body) : null;
    const proto    = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname : u.hostname,
      port     : u.port || (u.protocol === 'https:' ? 443 : 80),
      path     : u.pathname + u.search,
      method,
      headers  : { 'Content-Type': 'application/json', ...headers }
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

// ─── Claude helper ────────────────────────────────────────────────────────────
async function callClaude(prompt, model = 'claude-sonnet-4-5', maxTokens = 2000) {
  const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
    'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'
  }, { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });

  if (r.status !== 200) throw new Error(`Claude ${model}: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);

  const raw = r.body?.content?.[0]?.text || '';
  try { return JSON.parse(raw); } catch {}
  const stripped = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  // Try array too
  const as = raw.indexOf('['), ae = raw.lastIndexOf(']');
  if (as !== -1 && ae > as) { try { return JSON.parse(raw.slice(as, ae + 1)); } catch {} }
  return { _raw: raw };
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

// ─── Replicate image generation (Flux 1.1 Pro) ───────────────────────────────
async function generateImage(prompt, fallbackQuery = 'business marketing professional') {
  // Try Replicate first
  try {
    const pred = await apiRequest('POST', 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
      { 'Authorization': `Bearer ${REPLICATE_API_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
      { input: { prompt: prompt.slice(0, 500), aspect_ratio: '1:1', output_format: 'webp', safety_tolerance: 2 } });

    if (pred.status === 200 || pred.status === 201) {
      let output = pred.body?.output;
      // If not immediately ready, poll
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
        if (url && url.startsWith('http')) return { url, source: 'replicate' };
      }
    }
  } catch (e) { console.error('[Replicate] error:', e.message); }

  // Pexels fallback
  try {
    const r = await apiRequest('GET',
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(fallbackQuery)}&per_page=1&orientation=square`,
      { 'Authorization': PEXELS_API_KEY });
    if (r.status === 200 && r.body?.photos?.[0]) {
      const photo = r.body.photos[0];
      return { url: photo.src?.medium || photo.src?.original, source: 'pexels', credit: photo.photographer };
    }
  } catch (e) { console.error('[Pexels] error:', e.message); }

  return { url: null, source: 'none' };
}

// ─── Email helper (Resend HTTPS API — works on Railway, no SMTP needed) ──────
// Railway blocks outbound SMTP (465/587). Resend uses HTTPS port 443 only.
// Sign up free at resend.com → get API key → set RESEND_API_KEY on Railway.
// Set FROM_EMAIL to a verified domain address (or leave as onboarding@resend.dev for testing).
async function sendEmail(to, subject, html) {
  const apiKey = clean(process.env.RESEND_API_KEY) || RESEND_API_KEY;
  const from   = clean(process.env.FROM_EMAIL)     || FROM_EMAIL;

  if (!apiKey || !to) {
    console.log(`[EMAIL QUEUED] To: ${to} | Subject: ${subject} — RESEND_API_KEY not set`);
    return { queued: true };
  }

  try {
    const r = await apiRequest('POST', 'https://api.resend.com/emails',
      { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      { from: `maroa.ai <${from}>`, to: [to], reply_to: 'hello@maroa.ai', subject, html }
    );
    if (r.status === 200 || r.status === 201) {
      console.log(`[EMAIL SENT] To: ${to} | id: ${r.body?.id}`);
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

    console.log(`[LEARNING] ${businessId}: best=${best.join(',')} worst=${worst.join(',')}`);
  } catch (e) {
    console.error('[LEARNING ERROR]', e.message);
  }
}

// ─── Log helper ───────────────────────────────────────────────────────────────
function log(route, msg) { console.log(`[${new Date().toISOString()}] ${route} — ${msg}`); }

async function logError(businessId, workflowName, errorMessage, retryPayload = null) {
  try {
    await sbPost('errors', { business_id: businessId, workflow_name: workflowName,
      error_message: errorMessage, retry_payload: retryPayload ? JSON.stringify(retryPayload) : null });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => res.json({
  status: 'ok', service: 'maroa-api', version: '2.0.0',
  env: {
    SUPABASE_KEY  : SUPABASE_KEY  ? `set (${SUPABASE_KEY.slice(0,8)}...)`  : 'MISSING',
    ANTHROPIC_KEY : ANTHROPIC_KEY ? `set (${ANTHROPIC_KEY.slice(0,15)}...)`: 'MISSING',
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
app.get('/debug', async (req, res) => {
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
  const metaAppId  = clean(process.env.META_APP_ID)     || '26551713411132003 (hardcoded default)';
  out.META_APP_SECRET = metaSecret ? `set (${metaSecret.length} chars)` : 'MISSING ❌ — set this in Railway env vars';
  out.META_APP_ID     = metaAppId  ? `set: ${metaAppId}` : 'MISSING';
  out.RESEND_API_KEY  = (clean(process.env.RESEND_API_KEY) || '') ? 'set' : 'missing';
  out.REPLICATE_API_KEY = (clean(process.env.REPLICATE_API_KEY) || '') ? 'set' : 'missing';

  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// WF03: POST /webhook/new-user-signup — 7-step intelligent onboarding
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/new-user-signup', async (req, res) => {
  const body = req.body;
  const { email, first_name, business_name, industry, business_id } = body;
  log('/webhook/new-user-signup', `email=${email} business=${business_name}`);

  if (!email) return res.status(400).json({ error: 'email required' });

  // Respond immediately so frontend doesn't time out
  res.json({ received: true, message: 'Onboarding started — your strategy is being built now', steps: 7 });

  // All 7 steps run async
  try {
    // ── Step 1: Save all onboarding data immediately ──────────────────────────
    const onboardingData = {
      email, first_name, business_name, industry,
      location         : body.location,
      city             : body.city,
      state            : body.state,
      business_type    : body.business_type || industry,
      target_audience  : body.target_audience,
      brand_tone       : body.brand_tone,
      marketing_goal   : body.marketing_goal,
      dream_customer   : body.dream_customer,
      unique_differentiator : body.unique_differentiator,
      customer_pain_points  : body.customer_pain_points,
      primary_goal     : body.primary_goal || body.marketing_goal,
      monthly_budget   : body.monthly_budget || body.daily_budget * 30 || 300,
      daily_budget     : body.daily_budget || 10,
      selected_platforms    : body.selected_platforms ? JSON.stringify(body.selected_platforms) : JSON.stringify(['instagram', 'facebook']),
      website_url      : body.website_url,
      num_employees    : body.num_employees,
      business_description  : body.business_description,
      onboarding_step  : 1,
      onboarding_complete   : false,
      autopilot_enabled     : true,
      performance_baseline  : JSON.stringify({ reach: 0, impressions: 0, clicks: 0, leads: 0, spend: 0, roas: 0 })
    };

    // Remove undefined values
    Object.keys(onboardingData).forEach(k => onboardingData[k] === undefined && delete onboardingData[k]);

    let bizId = business_id;
    if (bizId) {
      await sbPatch('businesses', `id=eq.${bizId}`, onboardingData);
    } else {
      // Try to find existing by email
      const existing = await sbGet('businesses', `email=eq.${encodeURIComponent(email)}&select=id`);
      if (existing[0]) {
        bizId = existing[0].id;
        await sbPatch('businesses', `id=eq.${bizId}`, onboardingData);
      } else {
        const created = await sbPost('businesses', { ...onboardingData, is_active: true });
        bizId = created?.id;
      }
    }

    log('/webhook/new-user-signup', `Step 1 ✅ saved onboarding — bizId=${bizId}`);

    // ── Step 2: Brand voice extraction from website ───────────────────────────
    let brandVoice = null;
    if (body.website_url) {
      try {
        brandVoice = await callClaude(
          `You are analyzing a business website to extract their complete brand identity.\n` +
          `Extract from this website URL ${body.website_url}:\n` +
          `1. Exact brand voice described in 3 adjectives\n` +
          `2. Writing style (formal/casual/funny/professional)\n` +
          `3. Key phrases they use repeatedly\n` +
          `4. Main products or services with descriptions\n` +
          `5. Unique selling proposition in one sentence\n` +
          `6. Target audience described as a real person\n` +
          `7. Pricing strategy (premium/budget/mid-range)\n` +
          `8. Emotional tone of their copy\n` +
          `Return only valid JSON with keys: voice_adjectives, writing_style, key_phrases, products_services, usp, target_person, pricing_strategy, emotional_tone`,
          'claude-opus-4-5', 1500
        );
        if (brandVoice && !brandVoice._raw) {
          await sbPatch('businesses', `id=eq.${bizId}`, { brand_voice_locked: JSON.stringify(brandVoice) });
          log('/webhook/new-user-signup', `Step 2 ✅ brand voice extracted`);
        }
      } catch (e) { log('/webhook/new-user-signup', `Step 2 WARN: ${e.message}`); }
    }

    // ── Step 3: Competitor research via SerpAPI ───────────────────────────────
    let competitorData = [];
    try {
      const city  = body.city  || body.location || '';
      const state = body.state || '';
      const btype = body.business_type || industry || business_name;
      const query = `${btype} ${city} ${state} near me`.trim();
      const results = await serpSearch(query, 5);
      competitorData = results.map(r => r.title + ': ' + r.snippet).join('\n');
      if (competitorData) {
        await sbPatch('businesses', `id=eq.${bizId}`, { competitors: competitorData });
        log('/webhook/new-user-signup', `Step 3 ✅ found ${results.length} competitors`);
      }
    } catch (e) { log('/webhook/new-user-signup', `Step 3 WARN: ${e.message}`); }

    // ── Step 4: Build comprehensive 30-day marketing strategy ─────────────────
    let strategy = null;
    try {
      const biz = (await sbGet('businesses', `id=eq.${bizId}&select=*`))[0] || body;
      const stratPrompt =
        `You are a world-class marketing strategist. Build a comprehensive 30-day marketing strategy.\n\n` +
        `BUSINESS PROFILE:\n` +
        `- Name: ${biz.business_name || business_name}\n` +
        `- Industry: ${biz.industry || industry}\n` +
        `- Location: ${biz.city || ''} ${biz.state || ''}\n` +
        `- Description: ${biz.business_description || ''}\n` +
        `- Dream Customer: ${biz.dream_customer || biz.target_audience || ''}\n` +
        `- Unique Differentiator: ${biz.unique_differentiator || ''}\n` +
        `- Customer Pain Points: ${biz.customer_pain_points || ''}\n` +
        `- Primary Goal: ${biz.primary_goal || biz.marketing_goal || ''}\n` +
        `- Monthly Budget: $${biz.monthly_budget || 300}\n` +
        `- Selected Platforms: ${biz.selected_platforms || '["instagram","facebook"]'}\n` +
        `- Brand Voice: ${biz.brand_voice_locked || biz.brand_tone || 'professional and friendly'}\n\n` +
        `COMPETITOR LANDSCAPE:\n${competitorData || 'Research needed'}\n\n` +
        `Build a strategy with:\n` +
        `1. 4 content pillars with rationale\n` +
        `2. Platform-specific tactics for each selected platform\n` +
        `3. Audience targeting parameters per platform\n` +
        `4. Budget allocation breakdown (awareness/engagement/retargeting)\n` +
        `5. Week-by-week 30-day action plan\n` +
        `6. KPIs and targets\n` +
        `7. Competitive positioning statement\n\n` +
        `Return only valid JSON with keys: content_pillars, platform_tactics, targeting, budget_allocation, week1, week2, week3, week4, kpis, positioning_statement, strategy_summary`;

      strategy = await callClaude(stratPrompt, 'claude-opus-4-5', 3000);
      if (strategy && !strategy._raw) {
        await sbPatch('businesses', `id=eq.${bizId}`, {
          marketing_strategy : JSON.stringify(strategy),
          onboarding_step    : 4,
          onboarding_complete: true
        });
        log('/webhook/new-user-signup', `Step 4 ✅ strategy built`);
      }
    } catch (e) { log('/webhook/new-user-signup', `Step 4 WARN: ${e.message}`); }

    // ── Step 5: Generate first week of content ────────────────────────────────
    let firstContent = null;
    try {
      const contentResult = await generateInstantContent(bizId, email);
      firstContent = contentResult;
      log('/webhook/new-user-signup', `Step 5 ✅ first week content generated`);
    } catch (e) { log('/webhook/new-user-signup', `Step 5 WARN: ${e.message}`); }

    // ── Step 6: Save performance baseline ─────────────────────────────────────
    try {
      await sbPatch('businesses', `id=eq.${bizId}`, {
        performance_baseline : JSON.stringify({ reach:0, impressions:0, clicks:0, leads:0, spend:0, roas:0, posts:0 }),
        onboarding_step      : 6
      });
      log('/webhook/new-user-signup', `Step 6 ✅ baseline saved`);
    } catch (e) { log('/webhook/new-user-signup', `Step 6 WARN: ${e.message}`); }

    // ── Step 7: Send beautiful welcome email ──────────────────────────────────
    try {
      const firstName = first_name || business_name || 'there';
      const stratSummary = strategy?.strategy_summary || 'Your personalized strategy is ready.';
      const pillars = strategy?.content_pillars ? (Array.isArray(strategy.content_pillars) ?
        strategy.content_pillars.slice(0,4).map(p => `<li>${typeof p === 'string' ? p : p.pillar || JSON.stringify(p)}</li>`).join('') : '') : '';
      const contentPreview = firstContent?.content_theme ? `<strong>${firstContent.content_theme}</strong>` : 'Ready to view in dashboard';

      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
<div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:40px;border-radius:16px;text-align:center;margin-bottom:30px">
  <h1 style="color:white;margin:0;font-size:28px">Welcome to maroa.ai, ${firstName}!</h1>
  <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:16px">Your AI marketing team is ready</p>
</div>
<div style="background:#f8f9ff;border-left:4px solid #667eea;padding:20px;border-radius:8px;margin-bottom:25px">
  <h3 style="margin:0 0 10px;color:#1a1a2e">Your 30-Day Strategy Summary</h3>
  <p style="margin:0;color:#555">${stratSummary}</p>
</div>
${pillars ? `<div style="margin-bottom:25px"><h3 style="color:#1a1a2e">Your 4 Content Pillars</h3><ul style="color:#555;line-height:2">${pillars}</ul></div>` : ''}
<div style="background:#f0fdf4;border:1px solid #86efac;padding:20px;border-radius:8px;margin-bottom:25px">
  <h3 style="margin:0 0 10px;color:#166534">First Week of Content</h3>
  <p style="margin:0;color:#555">Theme: ${contentPreview}</p>
  <p style="margin:10px 0 0;color:#555">Instagram, Facebook, Email, Google Ads — all ready to review in your dashboard.</p>
</div>
<div style="background:#fff8e7;border:1px solid #ffd166;padding:20px;border-radius:8px;margin-bottom:25px">
  <h3 style="margin:0 0 10px;color:#92400e">What Happens Next Week</h3>
  <ul style="color:#555;margin:0;padding-left:20px;line-height:2">
    <li>Your AI posts content automatically on the best days/times</li>
    <li>Ad campaigns launch and optimize themselves daily</li>
    <li>Competitor intelligence is analyzed every Friday</li>
    <li>Weekly strategy review happens every Sunday night</li>
    <li>Monthly performance report arrives on the 1st</li>
  </ul>
</div>
<div style="text-align:center;margin-bottom:30px">
  <a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#667eea;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">View Your Dashboard</a>
</div>
<div style="border-top:1px solid #e8e8f0;padding-top:20px;text-align:center">
  <p style="margin:0;font-size:12px;color:#999">Sent by maroa.ai · <a href="mailto:hello@maroa.ai" style="color:#667eea">hello@maroa.ai</a></p>
</div></body></html>`;

      await sendEmail(email, `Welcome ${firstName}! Your AI marketing strategy is ready`, html);
      log('/webhook/new-user-signup', `Step 7 ✅ welcome email sent`);
    } catch (e) { log('/webhook/new-user-signup', `Step 7 WARN: ${e.message}`); }

    log('/webhook/new-user-signup', `✅ All 7 steps complete for ${business_name}`);

  } catch (err) {
    console.error('[new-user-signup ERROR]', err.message);
    await logError(business_id, 'new-user-signup', err.message, req.body);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Core content generation function (shared by signup + instant-content)
// ─────────────────────────────────────────────────────────────────────────────
async function generateInstantContent(bizId, emailOverride) {
  // Fetch all context
  const [bizArr, recentContent, compInsights, learningArr] = await Promise.all([
    sbGet('businesses', `id=eq.${bizId}&select=*`),
    sbGet('generated_content', `business_id=eq.${bizId}&order=created_at.desc&limit=5`),
    sbGet('competitor_insights', `business_id=eq.${bizId}&order=recorded_at.desc&limit=1`),
    sbGet('learning_logs', `business_id=eq.${bizId}&order=created_at.desc&limit=1`)
  ]);

  const biz   = bizArr[0];
  if (!biz) throw new Error(`Business ${bizId} not found`);

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

  const prompt =
    `You are the AI marketing brain for ${biz.business_name}. Here is everything you know:\n\n` +
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

  let content = await callClaude(prompt, 'claude-sonnet-4-5', 3000);
  let score   = scoreContent(content);

  // Retry if quality below 80
  if (score < 80 && !content._raw) {
    log('generateContent', `Score ${score}/100 < 80, retrying for ${biz.business_name}...`);
    const retryPrompt = prompt + `\n\nIMPORTANT: Previous attempt scored ${score}/100. ` +
      `Fix these specific issues and ensure ALL quality requirements are met exactly.`;
    content = await callClaude(retryPrompt, 'claude-sonnet-4-5', 3000);
    score   = scoreContent(content);
  }

  // Generate image
  const imgQuery  = biz.industry || biz.business_type || 'small business marketing professional';
  const imgResult = await generateImage(content.image_prompt || `Professional marketing photo for ${biz.business_name}`, imgQuery);

  // Save to generated_content
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
    status                : 'pending_approval'
  });

  log('generateContent', `✅ saved row ${saved?.id} score=${score} theme="${content.content_theme}" img=${imgResult.source}`);

  // Update learning data after every generation
  setImmediate(() => updateLearning(bizId));

  return { ...content, row_id: saved?.id, quality_score: score, image: imgResult };
}

// ─────────────────────────────────────────────────────────────────────────────
// WF15: POST /webhook/instant-content
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/instant-content', async (req, res) => {
  const { business_id, email } = req.body;
  log('/webhook/instant-content', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  try {
    const result = await generateInstantContent(business_id, email);

    // Send content ready email
    if (email) {
      const html = `<h2>Your weekly content is ready!</h2>
<p>Theme: <strong>${result.content_theme || 'Weekly Content'}</strong></p>
<p>Quality Score: <strong>${result.quality_score}/100</strong></p>
<p>All platforms ready: Instagram, Facebook, LinkedIn, TikTok, Google Ads, Email</p>
<p><a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve Content</a></p>`;
      await sendEmail(email, `Your ${result.content_theme || 'weekly'} content is ready!`, html);
    }

    res.json({ success: true, row_id: result.row_id, content_theme: result.content_theme,
      quality_score: result.quality_score, image: result.image });
  } catch (err) {
    console.error('[instant-content ERROR]', err.message);
    await logError(business_id, 'instant-content', err.message, req.body);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WF10: POST /webhook/account-connected
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/account-connected', async (req, res) => {
  const { business_id, meta_access_token, linkedin_access_token, tiktok_access_token, google_access_token } = req.body;
  log('/webhook/account-connected', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });
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
<p><a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Go to Dashboard</a></p>`;
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

    const campaigns = await callClaude(campaignPrompt, 'claude-sonnet-4-5', 1500);
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

    log('/webhook/create-campaigns', `✅ Created ${savedIds.length} campaigns`);

    if (biz.email) {
      const html = `<h2>Your Ad Campaigns Are Ready!</h2>
<p>We've created 3 optimized Meta ad campaigns for <strong>${biz.business_name}</strong>:</p>
<ul><li>Awareness Campaign (40% budget)</li><li>Engagement Campaign (25% budget)</li><li>Retargeting Campaign (35% budget)</li></ul>
<p>All campaigns are set to PAUSED — activate them when ready in your dashboard.</p>
<p><a href="https://maroa-ai-marketing-automator.lovable.app" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Manage Campaigns</a></p>`;
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
  log('/webhook/content-approved', `content_id=${content_id}`);

  if (!content_id) return res.status(400).json({ error: 'content_id required' });

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
    if (!biz || !cont) return res.json({ success: true, note: 'approved but biz/content not found for publishing' });

    res.json({ success: true, message: 'Approved — autopublish in progress' });

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
    await logError(business_id, 'content-approved', err.message, req.body);
  }
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
      'claude-opus-4-5', 1500
    );

    if (insights && !insights._raw) {
      await sbPost('competitor_insights', {
        business_id,
        competitor_doing_well : insights.competitor_doing_well || '',
        gap_opportunity       : insights.gap_opportunity       || '',
        content_to_steal      : insights.content_to_steal      || '',
        positioning_tip       : insights.positioning_tip       || ''
      });
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
      'claude-sonnet-4-5', 1500
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
  const REDIRECT   = redirect_uri || 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

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
// Plans: free($0) · growth($49) · agency($99) — matching live DB + CLAUDE.md
// ═════════════════════════════════════════════════════════════════════════════

const PLANS = {
  free:   { name: 'Free',   price: 0,  priceId: null,
            features: ['5 posts/mo', 'FB+IG autopilot', 'Basic analytics'] },
  growth: { name: 'Growth', price: 49, priceId: (process.env.STRIPE_GROWTH_PRICE_ID || '').replace(/[^\x20-\x7E]/g,'').trim(),
            features: ['Unlimited posts', 'All platforms', 'Competitor intel', 'AI ads'] },
  agency: { name: 'Agency', price: 99, priceId: (process.env.STRIPE_AGENCY_PRICE_ID  || '').replace(/[^\x20-\x7E]/g,'').trim(),
            features: ['Everything in Growth', 'Multi-workspace (20 clients)', 'White-label', 'API access'] },
};

// GET /api/billing/plans — public, no auth needed
app.get('/api/billing/plans', (req, res) => {
  res.json({ plans: PLANS });
});

// POST /webhook/create-checkout — create Stripe Checkout Session
// Body: { business_id, plan }
app.post('/webhook/create-checkout', async (req, res) => {
  const { business_id, plan, success_url, cancel_url } = req.body;
  if (!business_id || !plan) return res.status(400).json({ error: 'business_id and plan required' });

  const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || '').replace(/[^\x20-\x7E]/g,'').trim();
  if (!STRIPE_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set in Railway env vars' });

  const planObj = PLANS[plan];
  if (!planObj)          return res.status(400).json({ error: `Unknown plan: ${plan}. Valid: free, growth, agency` });
  if (!planObj.priceId)  return res.status(400).json({ error: `No Stripe price ID for "${plan}". Set STRIPE_${plan.toUpperCase()}_PRICE_ID in Railway.` });

  const biz = (await sbGet('businesses', `id=eq.${business_id}&select=email,first_name,business_name`))[0];
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  try {
    const params = new URLSearchParams({
      'mode':                           'subscription',
      'line_items[0][price]':          planObj.priceId,
      'line_items[0][quantity]':       '1',
      'customer_email':                biz.email,
      'metadata[business_id]':         business_id,
      'metadata[plan]':                plan,
      'success_url':                   success_url || 'https://maroa-ai-marketing-automator.lovable.app/dashboard?upgraded=true',
      'cancel_url':                    cancel_url  || 'https://maroa-ai-marketing-automator.lovable.app/billing',
      'allow_promotion_codes':         'true',
    });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });
    const d = await r.json();
    if (!d.url) return res.status(400).json({ error: 'Stripe session creation failed', detail: d });
    log('/webhook/create-checkout', `Checkout for ${biz.email} → ${plan}`);
    res.json({ received: true, checkout_url: d.url, session_id: d.id });
  } catch (err) {
    console.error('[create-checkout ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const { org_id } = req.query;
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
<p><a href="https://maroa-ai-marketing-automator.lovable.app/accept-invite?org=${org_id}&email=${encodeURIComponent(email)}"
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
const LINKEDIN_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

// POST /webhook/linkedin-oauth-exchange
// Called by Lovable /social-callback with { code, business_id, redirect_uri? }
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
      const prompt = `You are a LinkedIn content expert. Generate a professional LinkedIn post for a ${biz.industry} business.
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
        { model: 'claude-sonnet-4-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] });

      const raw = aiResp.body?.content?.[0]?.text || '{}';
      let parsed = {};
      try { parsed = JSON.parse(raw); }
      catch { const m = raw.match(/{[\s\S]*}/); if(m) try { parsed = JSON.parse(m[0]); } catch {} }
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
const TWITTER_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

// POST /webhook/twitter-oauth-exchange
// Body: { code, business_id, code_verifier, redirect_uri? }
// Note: Lovable generates code_verifier + challenge client-side and sends verifier here
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
      const prompt = isThread
        ? `Write a 5-tweet thread for a ${biz.industry} business.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'expert'}.
Tweet 1: bold hook. Tweets 2-4: actionable value. Tweet 5: CTA.
Max 270 chars each. Max 1-2 hashtags total across the thread.
Return only valid JSON: {"tweets":["t1","t2","t3","t4","t5"],"content_theme":"..."}`
        : `Generate a tweet for a ${biz.industry} business. Max 280 characters.
Direct, engaging, ends with soft CTA. Max 2 hashtags.
Business: ${biz.business_name}, Tone: ${biz.brand_tone || 'professional'}, Audience: ${biz.target_audience || 'business owners'}.
Return only valid JSON: {"tweet":"...","content_theme":"..."}`;

      const aiResp = await apiRequest('POST', 'https://api.anthropic.com/v1/messages',
        { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        { model: 'claude-sonnet-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });

      const raw = aiResp.body?.content?.[0]?.text || '{}';
      let parsed = {};
      try { parsed = JSON.parse(raw); }
      catch { const m = raw.match(/{[\s\S]*}/); if(m) try { parsed = JSON.parse(m[0]); } catch {} }

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
const TIKTOK_REDIRECT_URI  = 'https://maroa-ai-marketing-automator.lovable.app/social-callback';

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
    const prompt = `Write a TikTok video script for a ${biz.industry} business.
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
      { model: 'claude-sonnet-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });

    const raw = aiResp.body?.content?.[0]?.text || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/{[\s\S]*}/); if(m) try { parsed = JSON.parse(m[0]); } catch {} }

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
  if (!apiKey || !to) { console.log(`[EMAIL QUEUED] ${to} — no key`); return { queued: true }; }
  try {
    const payload = { from: `maroa.ai <${from}>`, to: [to], reply_to: 'hello@maroa.ai', subject, html };
    if (tags.length) payload.tags = tags;
    const r = await apiRequest('POST', 'https://api.resend.com/emails',
      { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, payload);
    if ([200, 201].includes(r.status)) {
      console.log(`[EMAIL SENT] ${to} | id: ${r.body?.id}`);
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

    let report = await callClaude(makePrompt(false), 'claude-opus-4-5', 1000);
    if (report._raw) report = await callClaude(makePrompt(true), 'claude-opus-4-5', 800);

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
  <a href="https://maroa-ai-marketing-automator.lovable.app/analytics"
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

        const email = await callClaude(prompt, 'claude-sonnet-4-5', 600);
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
    if (!biz.meta_access_token)
      return res.status(400).json({ error: 'meta_ads_not_connected', detail: 'No Meta access token' });
    if (!biz.ad_account_id)
      return res.status(400).json({ error: 'meta_ads_not_connected', detail: 'No ad_account_id — connect Meta Ads in Settings' });
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

    const strategy   = await callClaude(strategyPrompt, 'claude-opus-4-5', 1500);
    const rawCreatives = Array.isArray(strategy.creatives) ? strategy.creatives.slice(0, 3) : [];
    const targeting    = strategy.targeting || { age_min: 25, age_max: 55, genders: [1, 2], geo_locations: { countries: ['US'] } };
    const campaignObj  = strategy.objective || objective;
    const campBudget   = strategy.daily_budget_usd || dailyBudget;

    // 2. Generate images via Flux / Pexels fallback
    const creativesWithImages = [];
    for (const cr of rawCreatives) {
      try {
        const img = await generateImage(
          cr.image_prompt || `${biz.industry} advertisement ${biz.business_name}`,
          `${biz.industry} marketing professional advertisement`
        );
        creativesWithImages.push({ ...cr, image_url: img.url, image_source: img.source });
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
// POST /webhook/meta-campaign-optimize
// Pulls 7-day insights for every active Meta campaign for this business,
// calls Claude Opus for action decision, executes it via Meta API.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/meta-campaign-optimize', async (req, res) => {
  const { business_id } = req.body;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Meta optimization started' });

  try {
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,marketing_goal,target_cpc,avg_order_value`))[0];
    if (!biz) return;

    const campaigns = await sbGet('ad_campaigns',
      `business_id=eq.${business_id}&platform=eq.meta&status=eq.active`);

    const actionsTaken = [];
    let optimizedCount = 0;

    for (const camp of campaigns) {
      try {
        // Pull 7-day insights from Meta
        const insR = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}/insights` +
          `?fields=impressions,clicks,spend,actions,cpc,ctr,frequency` +
          `&date_preset=last_7d&access_token=${camp.meta_access_token}`, {});

        if (insR.status !== 200) continue;
        const d = insR.body?.data?.[0] || {};

        const impressions  = parseInt(d.impressions  || 0);
        const clicks       = parseInt(d.clicks       || 0);
        const spend        = parseFloat(d.spend      || 0);
        const ctr          = parseFloat(d.ctr        || 0);
        const cpc          = spend > 0 && clicks > 0 ? spend / clicks : 0;
        const conversions  = (d.actions || [])
          .filter(a => a.action_type === 'purchase' || a.action_type === 'lead')
          .reduce((s, a) => s + parseInt(a.value || 0), 0);
        const revenue      = conversions * (biz.avg_order_value || 50);
        const roas         = spend > 0 ? revenue / spend : 0;
        const targetCpc    = parseFloat(biz.target_cpc || 2.00);

        // Snapshot analytics
        const today = new Date().toISOString().slice(0, 10);
        try {
          await sbUpsert('analytics_snapshots',
            { business_id, snapshot_date: today, platform: 'meta_ads',
              impressions, clicks, engagement: conversions, total_spend: spend },
            'business_id,snapshot_date,platform');
        } catch { /* non-critical */ }

        // Claude Opus — optimization decision
        const decisionPrompt =
`You are a Meta Ads optimizer. What action should be taken on this campaign?

Campaign ID: ${camp.meta_campaign_id}
Spend (7d): $${spend.toFixed(2)} | Impressions: ${impressions} | Clicks: ${clicks}
CTR: ${ctr.toFixed(2)}% | CPC: $${cpc.toFixed(2)} | Conversions: ${conversions} | ROAS: ${roas.toFixed(2)}x
Business goal: ${biz.marketing_goal || 'grow leads'} | Target CPC: $${targetCpc.toFixed(2)}

Rules:
- ROAS > 3 OR CTR > 3% → increase_budget (budget_change_pct: 20)
- CTR < 0.5% AND spend > $5 → decrease_budget (budget_change_pct: -20)
- CPC > target_cpc * 2 AND spend > $10 → decrease_budget (budget_change_pct: -30)
- 0 conversions AND spend > $50 AND CTR < 0.3% → pause
- ROAS < 1 AND spend > $30 → refresh_creative
- Otherwise → keep

Return ONLY JSON: {"action":"increase_budget"|"decrease_budget"|"pause"|"refresh_creative"|"keep","reason":"string","budget_change_pct":0}`;

        const decision = await callClaude(decisionPrompt, 'claude-opus-4-5', 400);
        const action   = decision.action || 'keep';
        const reason   = decision.reason || 'Performance within normal range';
        const changePct= decision.budget_change_pct || 0;

        // Execute action
        if ((action === 'increase_budget' || action === 'decrease_budget') && camp.meta_ad_set_id) {
          const currentBudget = camp.daily_budget || 10;
          const newBudget     = Math.max(1, Math.round(currentBudget * (1 + changePct / 100)));
          await apiRequest('POST', `https://graph.facebook.com/v19.0/${camp.meta_ad_set_id}`,
            { 'Content-Type': 'application/json' },
            { daily_budget: newBudget * 100, access_token: camp.meta_access_token });
          await sbPatch('ad_campaigns', `id=eq.${camp.id}`, { daily_budget: newBudget });
        } else if (action === 'pause') {
          await apiRequest('POST', `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}`,
            { 'Content-Type': 'application/json' },
            { status: 'PAUSED', access_token: camp.meta_access_token });
        }

        // Update campaign record
        await sbPatch('ad_campaigns', `id=eq.${camp.id}`, {
          last_decision:        action,
          last_decision_reason: reason,
          last_optimized_at:    new Date().toISOString(),
          impressions,
          clicks,
          total_spend:          spend,
          roas,
          ...(action === 'pause' ? { status: 'paused', paused_reason: reason } : {})
        });

        actionsTaken.push({ campaign_id: camp.id, action, reason });
        optimizedCount++;
      } catch (ce) {
        log('/webhook/meta-campaign-optimize', `Campaign ${camp.id} error: ${ce.message}`);
        await logError(business_id, 'meta-campaign-optimize', ce.message, { campaign_id: camp.id });
      }
    }

    log('/webhook/meta-campaign-optimize',
      `✅ Optimized ${optimizedCount}/${campaigns.length} Meta campaigns for ${business_id}`);
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

    const strategy = await callClaude(stratPrompt, 'claude-opus-4-5', 1500);
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

        const decision  = await callClaude(decisionPrompt, 'claude-opus-4-5', 400);
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
    const biz = (await sbGet('businesses',
      `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal`))[0];
    if (!biz) return res.status(404).json({ error: 'business not found' });

    // Pull existing creatives to avoid repetition
    let existingFilter = `business_id=eq.${business_id}&platform=eq.${platform}&order=created_at.desc&limit=5&select=headline,primary_text`;
    const existing = await sbGet('ad_creatives', existingFilter);
    const existingHeadlines = existing.map(c => c.headline).filter(Boolean).join('; ');

    const prompt =
`You are a world-class Meta/Google ad copywriter. Create ${count} distinct ad creative variants for this business.

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

    const raw = await callClaude(prompt, 'claude-sonnet-4-5', 1500);
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }

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
      `business_id=eq.${business_id}&order=tested_at.desc&limit=20`);

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

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Maroa.ai API v2.0 — port :${PORT}`);
  console.log(`  Layer 1: Execution ✓  Layer 2: Intelligence ✓  Layer 3: Learning ✓`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
