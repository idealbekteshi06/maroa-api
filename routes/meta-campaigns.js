'use strict';

/**
 * routes/meta-campaigns.js — Meta (Facebook + Instagram) Ads management.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up). 4 endpoints around campaign creation + activation +
 * optimization + read:
 *
 *   POST /webhook/meta-campaign-create     — AI strategy + 3 creatives + Meta API push
 *   POST /webhook/meta-campaign-activate   — flip PAUSED → ACTIVE (gated by paid_ads plan)
 *   POST /webhook/meta-campaign-optimize   — pause underperformers, scale winners
 *   GET  /webhook/meta-campaigns-get       — campaign + creative + summary read
 *
 * 2026-05-20: OAuth token plaintext columns were dropped by migration 073.
 * All reads go through oauthCrypto.readToken(business, 'meta_access_token')
 * which prefers the *_enc column and decrypts at the boundary. Tokens are
 * NEVER stored on ad_campaigns rows — they belong to businesses.
 */
const oauthCrypto = require('../lib/oauthCrypto');
const { validateMonthlyBudget } = require('../lib/adBudgetGuard');
const { THREADS_PLACEMENTS, THREADS_OBJECTIVES, graphBaseUrl } = require('../lib/metaMetrics');

// Selector for businesses rows used by Meta routes. Reads encrypted column;
// keep the plaintext column name in the list too in case a row predates
// the encryption backfill (oauthCrypto.readToken falls back gracefully).
const META_BIZ_SELECT =
  'business_name,email,first_name,industry,target_audience,location,brand_tone,marketing_goal,' +
  'competitors,meta_access_token,meta_access_token_enc,ad_account_id,facebook_page_id,' +
  'target_cpc,avg_order_value';

function register({
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
}) {
  app.post('/webhook/meta-campaign-create', async (req, res) => {
    const { business_id, objective = 'OUTCOME_TRAFFIC', monthly_budget = 300 } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    try {
      const biz = (
        await sbGet('businesses', `id=eq.${encodeURIComponent(business_id)}&select=${META_BIZ_SELECT},plan`)
      )[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      // Plan-aware hard ceiling. Refuse early before we burn Claude budget
      // strategizing a campaign the customer can't actually run.
      const budgetCheck = validateMonthlyBudget({ plan: biz.plan, monthlyBudget: monthly_budget });
      if (!budgetCheck.ok) {
        return res.status(400).json({ error: budgetCheck.code, detail: budgetCheck.detail });
      }
      const metaToken = oauthCrypto.readToken(biz, 'meta_access_token');
      const draftMode = !metaToken || !biz.ad_account_id;
      if (draftMode) {
        // DRAFT MODE — build strategy + creatives without Meta API
        res.json({
          received: true,
          status: 'draft',
          message: 'Campaign strategy being built in draft mode — connect Meta Ads to launch',
        });

        setImmediate(async () => {
          try {
            const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));
            const strategyPrompt = `You are a Meta Ads expert. Create a campaign strategy for ${biz.business_name} (${biz.industry}).
  Goal: ${biz.marketing_goal || 'grow'} | Budget: $${monthly_budget}/mo | Audience: ${biz.target_audience || 'general'}
  Location: ${biz.location || 'United States'} | Tone: ${biz.brand_tone || 'professional'}
  Return ONLY valid JSON: { "objective": "OUTCOME_TRAFFIC", "daily_budget_usd": ${dailyBudget}, "targeting": { "age_min": 25, "age_max": 55 }, "creatives": [{ "headline": "max 40 chars", "primary_text": "max 125 chars", "description": "max 30 chars", "cta": "LEARN_MORE", "image_prompt": "image description" }] }`;
            const strategy = await callClaude(strategyPrompt, 'strategy', 1500);
            const creatives = Array.isArray(strategy.creatives) ? strategy.creatives.slice(0, 3) : [];

            // Save draft campaign
            await sbPost('ad_campaigns', {
              business_id,
              platform: 'meta',
              status: 'draft',
              daily_budget: dailyBudget,
              objective: strategy.objective || objective,
              ai_strategy: JSON.stringify(strategy),
              last_decision: 'Draft — awaiting Meta Ads connection',
              last_decision_reason: 'Campaign ready to launch when ad account connected',
              business_name: biz.business_name,
            });

            // Save draft creatives
            for (const cr of creatives) {
              await sbPost('ad_creatives', {
                business_id,
                platform: 'meta',
                headline: cr.headline,
                primary_text: cr.primary_text,
                description: cr.description,
                cta: cr.cta,
                image_prompt: cr.image_prompt,
                status: 'draft',
              }).catch(() => {});
            }

            if (biz.email) {
              await sendEmail(
                biz.email,
                `Your ad campaign strategy is ready — ${biz.business_name}`,
                `<h2>Your AI Ad Campaign is Ready (Draft)</h2><p>Your AI built a complete ad strategy with ${creatives.length} creative variations.</p><p><strong>To launch:</strong> Connect your Meta Ads account in Settings.</p><p><a href="https://maroa.ai/settings" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Connect Meta Ads →</a></p>`
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
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=${META_BIZ_SELECT}`))[0];
      const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));
      const accountId = actId(biz.ad_account_id);
      const token = oauthCrypto.readToken(biz, 'meta_access_token');
      if (!token) {
        return res.status(400).json({ error: 'meta_not_connected', detail: 'Connect Meta in Settings → Connections.' });
      }

      // 1. Claude Opus — full campaign strategy + 3 creative variations
      const strategyPrompt = `You are a Meta Ads expert. Return ONLY valid JSON, no markdown, no explanation.
  
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

      const strategy = await callClaude(strategyPrompt, 'strategy', 1500);
      const rawCreatives = Array.isArray(strategy.creatives) ? strategy.creatives.slice(0, 3) : [];
      const targeting = strategy.targeting || {
        age_min: 25,
        age_max: 55,
        genders: [1, 2],
        geo_locations: { countries: ['US'] },
      };
      const campaignObj = strategy.objective || objective;
      const threadsEligible = THREADS_OBJECTIVES.has(String(campaignObj).toUpperCase());
      if (threadsEligible && req.body?.include_threads !== false) {
        targeting.publisher_platforms = ['facebook', 'instagram', 'threads'];
        targeting.facebook_positions = ['feed'];
        targeting.instagram_positions = ['stream', 'story', 'reels'];
        targeting.threads_positions = THREADS_PLACEMENTS;
      }
      const campBudget = strategy.daily_budget_usd || dailyBudget;

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
        } catch {
          creativesWithImages.push({ ...cr, image_url: null, image_source: 'none' });
        }
      }

      // 3. Create Meta Campaign
      const campaignName = `${biz.business_name} — ${campaignObj} — ${new Date().toISOString().slice(0, 10)}`;
      const campResp = await apiRequest(
        'POST',
        `${graphBaseUrl()}/${accountId}/campaigns`,
        { 'Content-Type': 'application/json' },
        { name: campaignName, objective: campaignObj, status: 'PAUSED', special_ad_categories: [], access_token: token }
      );

      if (!campResp.body?.id) throw new Error(`Campaign create failed: ${JSON.stringify(campResp.body).slice(0, 300)}`);
      const metaCampaignId = campResp.body.id;

      // 4. Create Ad Set
      const adSetResp = await apiRequest(
        'POST',
        `https://graph.facebook.com/v19.0/${accountId}/adsets`,
        { 'Content-Type': 'application/json' },
        {
          name: `${biz.business_name} — AdSet — ${new Date().toISOString().slice(0, 10)}`,
          campaign_id: metaCampaignId,
          daily_budget: Math.round(campBudget * 100),
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'LINK_CLICKS',
          targeting: JSON.stringify(targeting),
          status: 'PAUSED',
          access_token: token,
        }
      );

      if (!adSetResp.body?.id) throw new Error(`Ad set create failed: ${JSON.stringify(adSetResp.body).slice(0, 300)}`);
      const metaAdSetId = adSetResp.body.id;

      // 5. Save DB record early (so creatives can reference campaign_id).
      // Note: meta_access_token deliberately NOT stored here — tokens live
      // on the businesses row (encrypted) and are looked up at activate /
      // optimize time. Avoids duplicate storage + a per-campaign decrypt path.
      const campaignRow = await sbPost('ad_campaigns', {
        business_id,
        platform: 'meta',
        meta_campaign_id: metaCampaignId,
        meta_ad_set_id: metaAdSetId,
        facebook_page_id: biz.facebook_page_id,
        status: 'paused',
        daily_budget: campBudget,
        objective: campaignObj,
        ai_strategy: strategy,
        creatives: creativesWithImages.map((c) => ({ headline: c.headline, image_url: c.image_url })),
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
              const imgUp = await apiRequest(
                'POST',
                `https://graph.facebook.com/v19.0/${accountId}/adimages`,
                { 'Content-Type': 'application/json' },
                { url: cr.image_url, access_token: token }
              );
              const imgs = imgUp.body?.images;
              if (imgs) imageHash = imgs[Object.keys(imgs)[0]]?.hash;
            } catch {
              /* non-critical */
            }
          }

          // Build link_data
          const linkData = {
            message: cr.primary_text || '',
            link: `https://www.facebook.com/${biz.facebook_page_id || ''}`,
            name: (cr.headline || '').slice(0, 40),
            description: (cr.description || '').slice(0, 30),
            call_to_action: { type: cr.cta || 'LEARN_MORE' },
          };
          if (imageHash) linkData.image_hash = imageHash;

          // Create Ad Creative
          const creativeResp = await apiRequest(
            'POST',
            `https://graph.facebook.com/v19.0/${accountId}/adcreatives`,
            { 'Content-Type': 'application/json' },
            {
              name: `${biz.business_name} Creative ${i + 1}`,
              object_story_spec: JSON.stringify({ page_id: biz.facebook_page_id, link_data: linkData }),
              access_token: token,
            }
          );
          const metaCreativeId = creativeResp.body?.id;

          // Create Ad
          if (metaCreativeId) {
            const adResp = await apiRequest(
              'POST',
              `https://graph.facebook.com/v19.0/${accountId}/ads`,
              { 'Content-Type': 'application/json' },
              {
                name: `${biz.business_name} Ad ${i + 1}`,
                adset_id: metaAdSetId,
                creative: JSON.stringify({ creative_id: metaCreativeId }),
                status: 'PAUSED',
                access_token: token,
              }
            );
            if (adResp.body?.id) adsCreated.push({ ad_id: adResp.body.id, creative_id: metaCreativeId });
          }

          // Save to ad_creatives
          await sbPost('ad_creatives', {
            business_id,
            campaign_id: campaignRow?.id || null,
            platform: 'meta',
            headline: cr.headline,
            primary_text: cr.primary_text,
            description: cr.description,
            cta: cr.cta,
            image_url: cr.image_url,
            image_prompt: cr.image_prompt,
            meta_creative_id: metaCreativeId || null,
            status: 'active',
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
      try {
        storeInsight(
          business_id,
          'meta_ads',
          'ad_strategy',
          'ad_angle',
          `${campaignObj}: ${rawCreatives[0]?.headline || ''}`
        );
        storeInsight(
          business_id,
          'meta_ads',
          'ad_strategy',
          'ads_created',
          `${adsCreated.length} ads, budget $${campBudget}/day`
        );
      } catch {
        /* soft-fail */
      }
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
    if (!business_id || !campaign_id) return res.status(400).json({ error: 'business_id and campaign_id required' });
    try {
      const campaign = (
        await sbGet(
          'ad_campaigns',
          `id=eq.${encodeURIComponent(campaign_id)}&business_id=eq.${encodeURIComponent(business_id)}`
        )
      )[0];
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
      if (campaign.platform !== 'meta')
        return res.status(400).json({ error: 'Not a Meta campaign — use /webhook/google-campaign-activate' });

      // Token lives on the business, not the campaign (post-migration 073).
      const biz = (
        await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(business_id)}&select=meta_access_token,meta_access_token_enc`
        )
      )[0];
      const token = oauthCrypto.readToken(biz, 'meta_access_token');
      if (!token) {
        return res
          .status(400)
          .json({ error: 'meta_not_connected', detail: 'Reconnect Meta to activate this campaign.' });
      }

      // Activate campaign + ad set via Meta API
      await apiRequest(
        'POST',
        `https://graph.facebook.com/v19.0/${campaign.meta_campaign_id}`,
        { 'Content-Type': 'application/json' },
        { status: 'ACTIVE', access_token: token }
      );

      if (campaign.meta_ad_set_id) {
        await apiRequest(
          'POST',
          `https://graph.facebook.com/v19.0/${campaign.meta_ad_set_id}`,
          { 'Content-Type': 'application/json' },
          { status: 'ACTIVE', access_token: token }
        );
      }

      // Activate all ads for this campaign (stored in ad_creatives)
      // Pre-fetch creative rows to warm any Supabase cache; the actual
      // adsData below comes from campaign.creatives JSONB.
      const _creativeRows = await sbGet(
        'ad_creatives',
        `campaign_id=eq.${campaign_id}&platform=eq.meta&select=meta_creative_id`
      );
      // Note: we stored creative IDs; actual ad IDs would be in creatives JSONB
      const adsData = Array.isArray(campaign.creatives) ? campaign.creatives : [];
      for (const adEntry of adsData) {
        if (adEntry.ad_id) {
          try {
            await apiRequest(
              'POST',
              `https://graph.facebook.com/v19.0/${adEntry.ad_id}`,
              { 'Content-Type': 'application/json' },
              { status: 'ACTIVE', access_token: token }
            );
          } catch {
            /* individual ad activate failure is non-critical */
          }
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
      const biz = (
        await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(business_id)}&select=business_name,marketing_goal,target_cpc,avg_order_value,meta_access_token,meta_access_token_enc`
        )
      )[0];
      if (!biz) return;
      const metaToken = oauthCrypto.readToken(biz, 'meta_access_token');
      if (!metaToken) {
        return log('/webhook/meta-campaign-optimize', 'No meta_access_token — skipping');
      }

      const campaigns = await sbGet(
        'ad_campaigns',
        `business_id=eq.${encodeURIComponent(business_id)}&platform=eq.meta&status=eq.active`
      );

      if (!campaigns.length) return log('/webhook/meta-campaign-optimize', 'No active campaigns');

      // Pull 7-day insights for ALL campaigns
      const campData = [];
      for (const camp of campaigns) {
        try {
          const insR = await apiRequest(
            'GET',
            `https://graph.facebook.com/v19.0/${camp.meta_campaign_id}/insights` +
              `?fields=impressions,clicks,spend,actions,cpc,ctr,frequency` +
              `&date_preset=last_7d&access_token=${encodeURIComponent(metaToken)}`,
            {}
          );
          const d = insR.status === 200 ? insR.body?.data?.[0] || {} : {};
          const impressions = parseInt(d.impressions || 0);
          const clicks = parseInt(d.clicks || 0);
          const spend = parseFloat(d.spend || 0);
          const ctr = parseFloat(d.ctr || 0);
          const frequency = parseFloat(d.frequency || 0);
          const conversions = (d.actions || [])
            .filter((a) => a.action_type === 'purchase' || a.action_type === 'lead')
            .reduce((s, a) => s + parseInt(a.value || 0), 0);
          const revenue = conversions * (biz.avg_order_value || 50);
          const roas = spend > 0 ? revenue / spend : 0;
          campData.push({
            id: camp.id,
            meta_id: camp.meta_campaign_id,
            meta_ad_set_id: camp.meta_ad_set_id,
            name: camp.last_decision_reason || camp.campaign_type || 'campaign',
            daily_budget: camp.daily_budget || 10,
            impressions,
            clicks,
            spend,
            ctr,
            frequency,
            conversions,
            roas,
          });
        } catch {
          /* soft-fail */
        }
      }

      const totalSpend = campData.reduce((s, c) => s + c.spend, 0);
      const totalRevenue = campData.reduce((s, c) => s + c.conversions * (biz.avg_order_value || 50), 0);
      const portfolioRoas = totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : '0';

      // Claude Opus — full portfolio optimization decision
      const prompt = `You are a senior media buyer optimizing a full ad portfolio for ${biz.business_name}.
  Goal: ${biz.marketing_goal || 'maximize leads'}
  
  PORTFOLIO SUMMARY:
  Total spend (7d): $${totalSpend.toFixed(2)} | Total revenue: $${totalRevenue.toFixed(2)} | Portfolio ROAS: ${portfolioRoas}x
  
  INDIVIDUAL CAMPAIGNS:
  ${campData.map((c) => `- ${c.name}: budget=$${c.daily_budget}/day spend=$${c.spend.toFixed(2)} impressions=${c.impressions} clicks=${c.clicks} CTR=${c.ctr.toFixed(2)}% ROAS=${c.roas.toFixed(2)}x frequency=${c.frequency.toFixed(1)} conversions=${c.conversions}`).join('\n')}
  
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
        const camp = campData.find((c) => c.id === r.campaign_id);
        if (!camp) continue;
        try {
          if ((r.action === 'increase' || r.action === 'decrease') && camp.meta_ad_set_id && r.new_budget > 0) {
            await apiRequest(
              'POST',
              `https://graph.facebook.com/v19.0/${camp.meta_ad_set_id}`,
              { 'Content-Type': 'application/json' },
              { daily_budget: Math.round(r.new_budget * 100), access_token: metaToken }
            );
            await sbPatch('ad_campaigns', `id=eq.${camp.id}`, {
              daily_budget: r.new_budget,
              last_decision: `Portfolio ${r.action}: $${camp.daily_budget}→$${r.new_budget}`,
              last_decision_reason: r.reason,
              last_optimized_at: new Date().toISOString(),
            });
          } else if (r.action === 'pause') {
            await apiRequest(
              'POST',
              `https://graph.facebook.com/v19.0/${camp.meta_id}`,
              { 'Content-Type': 'application/json' },
              { status: 'PAUSED', access_token: metaToken }
            );
            await sbPatch('ad_campaigns', `id=eq.${camp.id}`, {
              status: 'paused',
              paused_reason: r.reason,
              last_optimized_at: new Date().toISOString(),
            });
          }
        } catch (e) {
          log('/webhook/meta-campaign-optimize', `Reallocation error ${camp.id}: ${e.message}`);
        }
      }

      // Log to ad_performance_logs
      try {
        await sbPost('ad_performance_logs', {
          business_id,
          recommendation: result.summary || '',
          reason: JSON.stringify(reallocations),
          spend: totalSpend,
          roas: parseFloat(portfolioRoas),
          logged_at: new Date().toISOString(),
        });
      } catch {
        /* soft-fail */
      }

      try {
        storeInsight(business_id, 'meta_ads', 'ad_strategy', 'portfolio_health', result.portfolio_health || '');
        storeInsight(business_id, 'meta_ads', 'ad_strategy', 'optimization_summary', result.summary || '');
      } catch {
        /* soft-fail */
      }
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
        sbGet('ad_creatives', `business_id=eq.${business_id}&platform=eq.meta&order=created_at.desc`),
      ]);
      const summary = {
        total: campaigns.length,
        active: campaigns.filter((c) => c.status === 'active').length,
        paused: campaigns.filter((c) => c.status === 'paused').length,
        total_spend: campaigns.reduce((a, c) => a + parseFloat(c.total_spend || 0), 0).toFixed(2),
        avg_roas: campaigns.length
          ? (campaigns.reduce((a, c) => a + parseFloat(c.roas || 0), 0) / campaigns.length).toFixed(2)
          : '0.00',
      };
      res.json({ campaigns, creatives, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
