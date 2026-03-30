// server.js — Maroa.ai Webhook API Server
// Replaces broken n8n Cloud webhook triggers.
// Handles: /webhook/instant-content, /webhook/new-user-signup, /webhook/account-connected
//
// Usage:
//   npm install && node server.js
//   PORT=3000 node server.js   (default port: 3000)

const express = require('express');
const https   = require('https');

const app  = express();
app.use(express.json());

// ─── Config (set via env vars in production) ──────────────────────────────────
// .replace strips any invisible characters (newlines, tabs, zero-width spaces)
// that can sneak in when pasting values into Railway / Heroku / etc.
const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL    = clean(process.env.SUPABASE_URL)  || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_KEY    = clean(process.env.SUPABASE_KEY)  || '';
const ANTHROPIC_KEY   = clean(process.env.ANTHROPIC_KEY) || '';
const PORT            = process.env.PORT                 || 3000;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function apiRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqBody = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers:  { 'Content-Type': 'application/json', ...headers }
    };
    if (reqBody) opts.headers['Content-Length'] = Buffer.byteLength(reqBody);

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
const sbHeaders = () => ({
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`
});

async function sbGet(table, query = '') {
  const r = await apiRequest('GET', `${SUPABASE_URL}/rest/v1/${table}?${query}`, sbHeaders());
  if (r.status !== 200) throw new Error(`Supabase GET ${table}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function sbPost(table, data) {
  const r = await apiRequest('POST', `${SUPABASE_URL}/rest/v1/${table}`,
    { ...sbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, data);
  if (![200, 201].includes(r.status)) throw new Error(`Supabase POST ${table}: ${r.status} ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

async function sbPatch(table, filter, data) {
  const r = await apiRequest('PATCH', `${SUPABASE_URL}/rest/v1/${table}?${filter}`,
    { ...sbHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, data);
  if (![200, 201, 204].includes(r.status)) throw new Error(`Supabase PATCH ${table}: ${r.status}`);
  return true;
}

// ─── Claude helper ────────────────────────────────────────────────────────────
async function callClaude(prompt, model = 'claude-sonnet-4-5', maxTokens = 2000) {
  const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
    'x-api-key':        ANTHROPIC_KEY,
    'anthropic-version':'2023-06-01',
    'Content-Type':     'application/json'
  }, { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });

  if (r.status !== 200) throw new Error(`Claude API: ${r.status} ${JSON.stringify(r.body)}`);

  const raw = r.body?.content?.[0]?.text || '';
  // Try 1: direct parse
  try { return JSON.parse(raw); } catch {}
  // Try 2: strip markdown code fences then parse
  const stripped = raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim();
  try { return JSON.parse(stripped); } catch {}
  // Try 3: extract outermost { ... } (handles text before/after JSON)
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return {};
}

// ─── Route helpers ────────────────────────────────────────────────────────────
function log(route, msg) {
  console.log(`[${new Date().toISOString()}] ${route} — ${msg}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'maroa-api', version: '1.2.0',
    env: {
      SUPABASE_KEY:  SUPABASE_KEY  ? `set (${SUPABASE_KEY.slice(0,8)}...)` : 'MISSING',
      ANTHROPIC_KEY: ANTHROPIC_KEY ? `set (${ANTHROPIC_KEY.slice(0,12)}...)` : 'MISSING',
      SUPABASE_URL:  SUPABASE_URL
    },
    routes: [
      'POST /webhook/instant-content',
      'POST /webhook/new-user-signup',
      'POST /webhook/account-connected',
      'POST /webhook/content-approved',
      'POST /webhook/budget-updated',
      'POST /webhook/competitor-check',
      'POST /webhook/create-campaigns',
      'POST /webhook/generate-landing-page',
      'GET  /debug'
    ]
  });
});

// ─── Debug — tests live connectivity to Supabase + Anthropic ─────────────────
app.get('/debug', async (req, res) => {
  const results = { supabase: null, anthropic: null };
  try {
    const r = await sbGet('businesses', 'select=id&limit=1');
    results.supabase = `ok — ${r.length} row(s) returned`;
  } catch (e) { results.supabase = `ERROR: ${e.message}`; }

  try {
    const r = await apiRequest('POST', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json'
    }, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] });
    results.anthropic = r.status === 200 ? 'ok' : `ERROR: status ${r.status} — ${JSON.stringify(r.body).slice(0,100)}`;
  } catch (e) { results.anthropic = `ERROR: ${e.message}`; }

  res.json(results);
});

// ─── WF15: Instant Content On Signup ─────────────────────────────────────────
// Generates a full week of content for a business and saves to generated_content
app.post('/webhook/instant-content', async (req, res) => {
  const { business_id, email, first_name, business_name } = req.body;
  log('/webhook/instant-content', `business_id=${business_id} email=${email}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'SUPABASE_KEY env var not set on server' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY env var not set on server' });

  try {
    // Fetch business profile
    const businesses = await sbGet('businesses', `select=*&id=eq.${business_id}`);
    const biz = businesses[0] || { id: business_id, business_name, industry: 'general', email };

    log('/webhook/instant-content', `Generating content for: ${biz.business_name}`);

    const content = await callClaude(
      `Generate a full week of marketing content for ${biz.business_name || business_name} ` +
      `in the ${biz.industry || 'general'} industry. ` +
      `Location: ${biz.location || ''}. Target audience: ${biz.target_audience || ''}. ` +
      `Brand tone: ${biz.brand_tone || 'professional and friendly'}. ` +
      `Marketing goal: ${biz.marketing_goal || 'grow brand awareness'}. ` +
      `Return ONLY valid JSON with keys: instagram_caption, instagram_caption_2, facebook_post, ` +
      `instagram_story_text, email_subject, email_body, blog_title, ` +
      `google_ad_headline, google_ad_description, content_theme.`
    );

    const saved = await sbPost('generated_content', {
      business_id,
      instagram_caption:     content.instagram_caption     || '',
      instagram_caption_2:   content.instagram_caption_2   || '',
      facebook_post:         content.facebook_post         || '',
      instagram_story_text:  content.instagram_story_text  || '',
      email_subject:         content.email_subject         || '',
      email_body:            content.email_body            || '',
      blog_title:            content.blog_title            || '',
      google_ad_headline:    content.google_ad_headline    || '',
      google_ad_description: content.google_ad_description || '',
      content_theme:         content.content_theme         || '',
      status:                'pending_approval'
    });

    log('/webhook/instant-content', `✅ Saved row ${saved?.id} — theme: ${content.content_theme}`);
    res.json({ success: true, row_id: saved?.id, content_theme: content.content_theme, message: 'Content saved to Supabase' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/instant-content ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── WF3: New User Onboarding ─────────────────────────────────────────────────
// Generates 30-day marketing strategy via Claude Opus and saves to businesses table
app.post('/webhook/new-user-signup', async (req, res) => {
  // Accept business_id OR user_id — callers may send either
  const { user_id, business_id, email, first_name, business_name, industry, location, plan } = req.body;
  const lookupId = business_id || user_id;
  log('/webhook/new-user-signup', `lookup=${lookupId} email=${email}`);

  if (!email) return res.status(400).json({ error: 'email required' });
  res.json({ received: true, message: 'Onboarding started' });

  try {
    const strategy = await callClaude(
      `Create a concise 30-day marketing strategy for a new ${plan || 'free'} plan user. ` +
      `Business: ${business_name}, Industry: ${industry || 'general'}, Location: ${location || 'unknown'}. ` +
      `Return ONLY valid JSON (no markdown) with keys: week1, week2, week3, week4, key_channels, quick_wins, ` +
      `content_pillars, target_metrics, strategy_summary. Keep each value under 100 words.`,
      'claude-sonnet-4-5', 2000
    );

    if (lookupId) {
      // Try patching by id (business primary key) first — most callers send this
      const patchFilter = business_id ? `id=eq.${business_id}` : `user_id=eq.${user_id}`;
      await sbPatch('businesses', patchFilter,
        { marketing_strategy: JSON.stringify(strategy), onboarding_complete: true });
      log('/webhook/new-user-signup', `✅ Strategy saved (filter: ${patchFilter})`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/new-user-signup ERROR:`, err.message);
  }
});

// ─── WF10: Account Connected (Lookalike Audience) ────────────────────────────
// Triggered when a user connects their Meta account
app.post('/webhook/account-connected', async (req, res) => {
  const { business_id, email, business_name } = req.body;
  log('/webhook/account-connected', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Account connection processing started' });

  try {
    const businesses = await sbGet('businesses', `select=*&id=eq.${business_id}`);
    const biz = businesses[0];
    if (!biz) throw new Error(`Business ${business_id} not found`);

    log('/webhook/account-connected', `✅ Processing Meta connection for ${biz.business_name}`);
    // Meta audience creation handled by n8n WF10 scheduled flows
    // This endpoint acknowledges the connection and logs the event
    await sbPost('onboarding_events', {
      business_id,
      event_type: 'account_connected',
      event_data: JSON.stringify({ email, business_name, timestamp: new Date().toISOString() })
    });
    log('/webhook/account-connected', `✅ Event logged for business ${business_id}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/account-connected ERROR:`, err.message);
  }
});

// ─── Content Approved ─────────────────────────────────────────────────────────
app.post('/webhook/content-approved', async (req, res) => {
  const { content_id, business_id, approval_method } = req.body;
  log('/webhook/content-approved', `content_id=${content_id}`);

  if (!content_id) return res.status(400).json({ error: 'content_id required' });
  res.json({ received: true, message: 'Content approval recorded' });

  try {
    await sbPatch('generated_content', `id=eq.${content_id}`, {
      status:          'approved',
      approved_at:     new Date().toISOString(),
      approval_method: approval_method || 'manual'
    });
    log('/webhook/content-approved', `✅ Content ${content_id} approved`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/content-approved ERROR:`, err.message);
  }
});

// ─── Budget Updated ───────────────────────────────────────────────────────────
app.post('/webhook/budget-updated', async (req, res) => {
  const { business_id, daily_budget } = req.body;
  log('/webhook/budget-updated', `business_id=${business_id} budget=${daily_budget}`);

  if (!business_id || daily_budget === undefined)
    return res.status(400).json({ error: 'business_id and daily_budget required' });
  res.json({ received: true, message: 'Budget update recorded' });

  try {
    await sbPatch('businesses', `id=eq.${business_id}`, { daily_budget });
    log('/webhook/budget-updated', `✅ Budget updated to ${daily_budget} for ${business_id}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/budget-updated ERROR:`, err.message);
  }
});

// ─── Competitor Check ─────────────────────────────────────────────────────────
app.post('/webhook/competitor-check', async (req, res) => {
  const { business_id } = req.body;
  log('/webhook/competitor-check', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Competitor check triggered' });

  try {
    const businesses = await sbGet('businesses', `select=*&id=eq.${business_id}`);
    const biz = businesses[0];
    if (!biz?.competitors) throw new Error('No competitors set for this business');

    const insights = await callClaude(
      `Analyze these competitors for ${biz.business_name}: ${biz.competitors}. ` +
      `Provide strategic insights. Return ONLY valid JSON with keys: ` +
      `competitor_doing_well, gap_opportunity, content_to_steal, positioning_tip.`
    );

    await sbPost('competitor_insights', {
      business_id,
      competitor_doing_well: insights.competitor_doing_well || '',
      gap_opportunity:       insights.gap_opportunity       || '',
      content_to_steal:      insights.content_to_steal      || '',
      positioning_tip:       insights.positioning_tip       || ''
    });
    log('/webhook/competitor-check', `✅ Insights saved for ${business_id}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/competitor-check ERROR:`, err.message);
  }
});

// ─── WF29: Ad Campaign Creator ────────────────────────────────────────────────
// Generates Meta ad campaign strategy via Claude and saves to ad_campaigns table
app.post('/webhook/create-campaigns', async (req, res) => {
  const { business_id } = req.body;
  log('/webhook/create-campaigns', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  res.json({ received: true, message: 'Campaign creation started' });

  try {
    const businesses = await sbGet('businesses', `select=*&id=eq.${business_id}`);
    const biz = businesses[0];
    if (!biz) throw new Error(`Business ${business_id} not found`);

    const campaign = await callClaude(
      `You are a Meta ads expert. Create an ad campaign strategy for this business:\n` +
      `Business: ${biz.business_name}, Industry: ${biz.industry}, Location: ${biz.location}.\n` +
      `Target Audience: ${biz.target_audience}. Marketing Goal: ${biz.marketing_goal}.\n` +
      `Daily Budget: $${biz.daily_budget || 10}. Brand Tone: ${biz.brand_tone}.\n` +
      `Return ONLY valid JSON with keys: campaign_name, objective, primary_text, headline, ` +
      `description, call_to_action, audience_interests, age_min, age_max, budget_recommendation.`
    );

    await sbPost('ad_campaigns', {
      business_id,
      business_name:        biz.business_name,
      status:               'pending',
      daily_budget:         biz.daily_budget || 10,
      last_decision:        'Campaign created by AI',
      last_decision_reason: campaign.campaign_name || 'New AI campaign'
    });
    log('/webhook/create-campaigns', `✅ Campaign saved for ${biz.business_name}: ${campaign.campaign_name}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/create-campaigns ERROR:`, err.message);
  }
});

// ─── WF31: Landing Page Generator ─────────────────────────────────────────────
// Generates full landing page copy via Claude and saves to post_drafts table
app.post('/webhook/generate-landing-page', async (req, res) => {
  const { business_id } = req.body;
  log('/webhook/generate-landing-page', `business_id=${business_id}`);

  if (!business_id) return res.status(400).json({ error: 'business_id required' });

  try {
    const businesses = await sbGet('businesses', `select=*&id=eq.${business_id}`);
    const biz = businesses[0];
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const page = await callClaude(
      `You are a world-class conversion copywriter. Create a complete high-converting landing page.\n` +
      `Business: ${biz.business_name}, Industry: ${biz.industry}, Location: ${biz.location}.\n` +
      `Target Audience: ${biz.target_audience}. Goal: ${biz.marketing_goal}. Tone: ${biz.brand_tone}.\n` +
      `Return ONLY valid JSON with keys: hero_headline, hero_subheadline, hero_cta, ` +
      `value_prop_1, value_prop_2, value_prop_3, social_proof, testimonial_1, testimonial_2, ` +
      `faq_1, faq_2, faq_3, closing_headline, closing_cta, meta_title, meta_description.`,
      'claude-sonnet-4-5', 3000
    );

    const saved = await sbPost('post_drafts', {
      business_id,
      post_text:          JSON.stringify(page),
      platforms_selected: '["landing_page"]',
      status:             'draft'
    });

    log('/webhook/generate-landing-page', `✅ Landing page saved — row ${saved?.id}`);
    res.json({ success: true, row_id: saved?.id, hero_headline: page.hero_headline, message: 'Landing page saved to Supabase' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] /webhook/generate-landing-page ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Maroa.ai API Server — listening on :${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Webhooks available at http://localhost:${PORT}/webhook/`);
  console.log(`  Health: http://localhost:${PORT}/`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
