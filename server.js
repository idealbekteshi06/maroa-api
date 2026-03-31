// server.js — Maroa.ai Webhook API Server v2.0
// Layer 1: Execution  | Layer 2: Intelligence  | Layer 3: Learning
// The AI does everything forever and gets smarter every week.

'use strict';
const express = require('express');
const https   = require('https');
const http    = require('http');

const app = express();
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
    'POST /webhook/new-user-signup', 'POST /webhook/instant-content',
    'POST /webhook/account-connected', 'POST /webhook/create-campaigns',
    'POST /webhook/content-approved', 'POST /webhook/budget-updated',
    'POST /webhook/competitor-check', 'POST /webhook/generate-landing-page',
    'POST /test-email', 'GET  /debug'
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
      updates.meta_access_token = meta_access_token;

      try {
        const pagesResp = await apiRequest('GET',
          `https://graph.facebook.com/v19.0/me/accounts?access_token=${meta_access_token}&fields=id,name,fan_count`);
        if (pagesResp.body?.data?.[0]) {
          const page = pagesResp.body.data[0];
          updates.facebook_page_id = page.id;
          updates.followers_gained = page.fan_count || 0;
          connected.push(`Facebook (${page.name})`);

          // Get Instagram business account
          const igResp = await apiRequest('GET',
            `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${meta_access_token}`);
          if (igResp.body?.instagram_business_account?.id) {
            updates.instagram_account_id = igResp.body.instagram_business_account.id;
            connected.push('Instagram');
          }
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

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Maroa.ai API v2.0 — port :${PORT}`);
  console.log(`  Layer 1: Execution ✓  Layer 2: Intelligence ✓  Layer 3: Learning ✓`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
