'use strict';

/**
 * routes/paid-ads.js — channel-separated Paid Ads hub (Meta / Google / TikTok).
 *
 * 3 endpoints backing the frontend Paid Ads hub:
 *
 *   POST /webhook/tiktok-campaign-create  — eligibility gate + AI strategy → draft row
 *   GET  /webhook/tiktok-campaigns-get    — ad_campaigns platform=tiktok + summary
 *   GET  /webhook/paid-ads-overview       — per-channel { connected, campaigns,
 *                                           active, total_spend, avg_roas, eligibility }
 *
 * All routes live under /webhook/* so the global JWT + owner middleware in
 * server.js covers them — no route-local auth here.
 *
 * TikTok create NEVER live-launches. It persists a platform='tiktok' draft
 * (metadata.dry_run = true); actual spend stays behind the existing launcher's
 * TIKTOK_ADS_LIVE / per-business ads_live consent gates.
 *
 * Connection detection reads the businesses token columns and treats presence
 * of either the plaintext or the *_enc encrypted variant as connected
 * (plaintext columns were dropped by migration 073; select=* keeps this module
 * schema-drift-proof either way).
 */

const { normalizeWizard, wizardDailyBudget, wizardPromptBlock } = require('../lib/adWizard');
const { validateMonthlyBudget } = require('../lib/adBudgetGuard');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Presence of either the plaintext or encrypted token column = connected.
function hasToken(biz, col) {
  return Boolean(biz && (biz[col] || biz[`${col}_enc`]));
}

// Some legacy TikTok rows (cold-start launcher) carry the platform only in
// metadata JSONB — honor both.
function platformOf(campaign) {
  return campaign?.platform || campaign?.metadata?.platform || null;
}

// Mirror the summary shape of /webhook/google-campaigns-get.
function summarize(campaigns) {
  return {
    total: campaigns.length,
    active: campaigns.filter((c) => c.status === 'active').length,
    paused: campaigns.filter((c) => c.status === 'paused').length,
    total_spend: campaigns.reduce((a, c) => a + parseFloat(c.total_spend || 0), 0).toFixed(2),
    avg_roas: campaigns.length
      ? (campaigns.reduce((a, c) => a + parseFloat(c.roas || 0), 0) / campaigns.length).toFixed(2)
      : '0.00',
  };
}

function register({ app, sbGet, sbPost, sbPatch, callClaude, apiError, log, logError, tiktokAds, env }) {
  void sbPatch; // reserved for future activate/pause endpoints
  void env; // live-launch env gates stay in the launcher, not here

  // ───────────────────────────────────────────────────────────────────────
  // POST /webhook/tiktok-campaign-create
  // body: { business_id, wizard?: { objective, target_audience, age_range,
  //         locations[], daily_budget, duration_days, offer } }
  // Draft-only: strategy + persisted row; NEVER touches the TikTok Ads API.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/webhook/tiktok-campaign-create', async (req, res) => {
    const { business_id } = req.body || {};
    const wizard = normalizeWizard(req.body?.wizard);
    if (!isUUID(business_id)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');
    }

    try {
      const biz = (await sbGet('businesses', `id=eq.${encodeURIComponent(business_id)}&select=*`))[0];
      if (!biz) return apiError(res, 404, 'BUSINESS_NOT_FOUND', 'business not found');

      // Eligibility gate — TikTok requires $50/day + business verification.
      // Wizard budget wins over the profile default when the user set one.
      const dailyBudget = wizardDailyBudget(wizard) ?? (Number(biz.daily_budget) || 0);
      const eligibility = tiktokAds.eligibilityVerdict({
        dailyBudget,
        businessVerified: biz.tiktok_business_verified !== false,
      });
      if (!eligibility.eligible) {
        return res.status(400).json({ error: 'tiktok_not_eligible', eligibility });
      }

      // Plan budget ceiling (parity with meta/google campaign-create): a wizard
      // daily_budget must not push monthly spend past the plan tier. Without
      // this, a $5000/day wizard input bypassed the cap the other channels enforce.
      const budgetCheck = validateMonthlyBudget({ plan: biz.plan, monthlyBudget: dailyBudget * 30 });
      if (!budgetCheck.ok) {
        return apiError(res, 400, budgetCheck.code || 'BUDGET_OVER_PLAN_CEILING', budgetCheck.detail);
      }

      const strategyPrompt = `You are a TikTok Ads expert (Smart+ campaigns, Spark Ads bias for SMB budgets). Return ONLY valid JSON, no markdown, no explanation.

Create a TikTok Smart+ campaign strategy for ${biz.business_name} (${biz.industry || 'small business'}).
Goal: ${biz.marketing_goal || 'grow brand awareness and leads'}
Daily budget: $${dailyBudget}/day (campaign minimum is $50/day, ad-group minimum $20/day)
Target audience: ${biz.target_audience || 'general consumers'}
Location: ${biz.location || 'United States'}
Brand tone: ${biz.brand_tone || 'professional and friendly'}
${wizardPromptBlock(wizard)}
Prefer Spark Ads (boosted organic posts, $1-4 CPM) over In-Feed ($4-10 CPM) when organic material exists.

Return exactly this JSON:
{
  "objective": "TRAFFIC|LEAD_GENERATION|CONVERSIONS",
  "daily_budget_usd": ${dailyBudget},
  "ad_groups": [
    { "name": "string", "audience": "lookalike_narrow|interest|broad", "daily_budget_usd": 20, "ad_type": "spark_ads|in_feed" }
  ],
  "creatives": [
    { "hook": "first-2-seconds hook, max 60 chars", "caption": "max 100 chars", "cta": "string", "video_concept": "1-2 sentence concept for a 15-30s vertical video" }
  ]
}`;

      const strategy = await callClaude(strategyPrompt, 'strategy', 1500);

      const campaign = await sbPost('ad_campaigns', {
        business_id,
        business_name: biz.business_name,
        platform: 'tiktok',
        status: 'draft',
        daily_budget: dailyBudget,
        objective: wizard?.objective || strategy.objective || 'TRAFFIC',
        ai_strategy: strategy,
        last_decision: 'Draft — TikTok Smart+ strategy generated from wizard',
        last_decision_reason: 'Draft only — live launch stays behind TIKTOK_ADS_LIVE + ads_live consent gates',
        metadata: {
          platform: 'tiktok',
          dry_run: true,
          source: 'paid-ads-wizard',
          smart_plus: true,
          wizard: wizard || null,
        },
      });

      log?.('/webhook/tiktok-campaign-create', `✅ TikTok draft campaign saved for ${biz.business_name}`);
      return res.json({ campaign, eligibility });
    } catch (err) {
      await logError?.(business_id, 'tiktok-campaign-create', err.message, req.body).catch(() => {});
      return apiError(res, 500, 'TIKTOK_CAMPAIGN_CREATE_FAILED', err.message);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET /webhook/tiktok-campaigns-get?business_id=X
  // Mirrors /webhook/google-campaigns-get: { campaigns, summary }.
  // ───────────────────────────────────────────────────────────────────────
  app.get('/webhook/tiktok-campaigns-get', async (req, res) => {
    const { business_id } = req.query;
    if (!isUUID(business_id)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');
    }
    try {
      // Fetch all rows and filter in JS — legacy cold-start TikTok rows carry
      // platform only inside metadata JSONB, so platform=eq.tiktok misses them.
      const all = await sbGet(
        'ad_campaigns',
        `business_id=eq.${encodeURIComponent(business_id)}&order=created_at.desc`
      );
      const campaigns = (all || []).filter((c) => platformOf(c) === 'tiktok');
      return res.json({ campaigns, summary: summarize(campaigns) });
    } catch (err) {
      return apiError(res, 500, 'TIKTOK_CAMPAIGNS_GET_FAILED', err.message);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET /webhook/paid-ads-overview?business_id=X
  // One call the hub renders from — per-channel connection + campaign stats
  // + launch eligibility for meta / google / tiktok.
  // ───────────────────────────────────────────────────────────────────────
  app.get('/webhook/paid-ads-overview', async (req, res) => {
    const { business_id } = req.query;
    if (!isUUID(business_id)) {
      return apiError(res, 400, 'VALIDATION_ERROR', 'business_id must be a valid UUID');
    }
    try {
      const encId = encodeURIComponent(business_id);
      const [bizRows, allCampaigns] = await Promise.all([
        sbGet('businesses', `id=eq.${encId}&select=*`),
        sbGet('ad_campaigns', `business_id=eq.${encId}&order=created_at.desc`),
      ]);
      const biz = bizRows?.[0];
      if (!biz) return apiError(res, 404, 'BUSINESS_NOT_FOUND', 'business not found');

      const byPlatform = { meta: [], google: [], tiktok: [] };
      for (const c of allCampaigns || []) {
        const p = platformOf(c);
        if (byPlatform[p]) byPlatform[p].push(c);
      }

      // ── Connection detection: plaintext OR *_enc token present ──────────
      const metaConnected = hasToken(biz, 'meta_access_token');
      const googleConnected = hasToken(biz, 'google_access_token') || hasToken(biz, 'google_refresh_token');
      const tiktokConnected = hasToken(biz, 'tiktok_access_token');

      // ── Per-channel launch eligibility ───────────────────────────────────
      const metaReasons = [];
      if (!metaConnected) metaReasons.push('Meta not connected — connect in Settings → Connections');
      if (!biz.ad_account_id) metaReasons.push('No Meta ad account on file (ad_account_id missing)');

      const googleReasons = [];
      if (!googleConnected) googleReasons.push('Google Ads not connected — connect in Settings → Connections');
      if (!biz.google_ads_customer_id) googleReasons.push('No Google Ads customer ID on file');
      if (!biz.website_url) googleReasons.push('Add your website URL so Google Ads has a landing page');

      const tiktokEligibility = tiktokAds.eligibilityVerdict({
        dailyBudget: Number(biz.daily_budget) || 0,
        businessVerified: biz.tiktok_business_verified !== false,
      });
      if (!tiktokConnected) {
        tiktokEligibility.eligible = false;
        tiktokEligibility.reasons = [
          'TikTok not connected — connect in Settings → Connections',
          ...tiktokEligibility.reasons,
        ];
      }

      const channel = (list, connected, eligibility) => {
        const s = summarize(list);
        return {
          connected,
          campaigns: s.total,
          active: s.active,
          total_spend: s.total_spend,
          avg_roas: s.avg_roas,
          eligibility,
        };
      };

      return res.json({
        business_id,
        generated_at: new Date().toISOString(),
        channels: {
          meta: channel(byPlatform.meta, metaConnected, { eligible: metaReasons.length === 0, reasons: metaReasons }),
          google: channel(byPlatform.google, googleConnected, {
            eligible: googleReasons.length === 0,
            reasons: googleReasons,
          }),
          tiktok: channel(byPlatform.tiktok, tiktokConnected, tiktokEligibility),
        },
      });
    } catch (err) {
      return apiError(res, 500, 'PAID_ADS_OVERVIEW_FAILED', err.message);
    }
  });
}

module.exports = { register };
