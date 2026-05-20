'use strict';

/**
 * routes/google-campaigns.js — Google Ads campaign management.
 *
 * 4 endpoints around Google Ads campaign create + activate + optimize + read:
 *
 *   POST /webhook/google-campaign-create   — AI keyword/ad strategy + Search campaign
 *   POST /webhook/google-campaign-activate — flip PAUSED → ENABLED (paid_ads gated)
 *   POST /webhook/google-campaign-optimize — pause low-CTR, scale high-CTR
 *   GET  /webhook/google-campaigns-get     — campaigns + summary read
 *
 * 2026-05-20 fixes (audit P0-4 + P0-5):
 *   - google_access_token + google_refresh_token now read via
 *     oauthCrypto.readToken so the encrypted `_enc` columns (migration 056 /
 *     073) are honored. Plaintext columns are dropped in production.
 *   - finalUrls is now sourced from businesses.website_url instead of the
 *     literal "https://www.google.com" placeholder. Refuse to create the
 *     campaign if no website_url is set so customers don't pay for clicks
 *     that go to Google's homepage.
 */
const oauthCrypto = require('../lib/oauthCrypto');
const { validateMonthlyBudget } = require('../lib/adBudgetGuard');

const G_BIZ_SELECT =
  'business_name,email,first_name,industry,target_audience,location,brand_tone,marketing_goal,' +
  'google_ads_customer_id,google_access_token,google_access_token_enc,google_refresh_token_enc,' +
  'website_url,target_cpc,avg_order_value';

function register({
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
}) {
  // ── Google Ads REST helper ────────────────────────────────────────────
  async function googleAdsReq(method, path, accessToken, body = null) {
    return apiRequest(
      method,
      `https://googleads.googleapis.com/v17/${path}`,
      {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': GOOGLE_ADS_DEV_TOKEN,
        'Content-Type': 'application/json',
      },
      body
    );
  }

  // Strip dashes from Google Ads customer ID (123-456-7890 → 1234567890)
  function gCid(raw) {
    return (raw || '').replace(/-/g, '');
  }

  // Normalize whatever the business profile holds into a clickable URL.
  function normalizeUrl(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    return `https://${s.replace(/^\/+/, '')}`;
  }

  app.post('/webhook/google-campaign-create', async (req, res) => {
    const { business_id, monthly_budget = 200 } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });

    // ── Preflight: business + connection + dev token ──────────────────
    try {
      const biz = (
        await sbGet('businesses', `id=eq.${encodeURIComponent(business_id)}&select=${G_BIZ_SELECT},plan`)
      )[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });
      // Plan-aware hard ceiling on monthly_budget.
      const budgetCheck = validateMonthlyBudget({ plan: biz.plan, monthlyBudget: monthly_budget });
      if (!budgetCheck.ok) {
        return res.status(400).json({ error: budgetCheck.code, detail: budgetCheck.detail });
      }
      if (!biz.google_ads_customer_id)
        return res.status(400).json({
          error: 'google_ads_not_connected',
          detail: 'No google_ads_customer_id — connect Google Ads in Settings',
        });
      const googleToken = oauthCrypto.readToken(biz, 'google_access_token');
      if (!googleToken)
        return res.status(400).json({ error: 'google_ads_not_connected', detail: 'No google_access_token' });
      if (!GOOGLE_ADS_DEV_TOKEN)
        return res
          .status(400)
          .json({ error: 'google_ads_not_configured', detail: 'GOOGLE_ADS_DEVELOPER_TOKEN not set on server' });
      const finalUrl = normalizeUrl(biz.website_url);
      if (!finalUrl)
        return res.status(400).json({
          error: 'website_url_required',
          detail: 'Add your website URL to Settings → Business profile so Google Ads has a destination.',
        });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    res.json({ received: true, message: 'Google Ads campaign creation started — check email in ~2 minutes' });

    try {
      const biz = (
        await sbGet('businesses', `id=eq.${encodeURIComponent(business_id)}&select=${G_BIZ_SELECT}`)
      )[0];

      const customerId = gCid(biz.google_ads_customer_id);
      const token = oauthCrypto.readToken(biz, 'google_access_token');
      const finalUrl = normalizeUrl(biz.website_url);
      const dailyBudget = Math.max(1, Math.round(monthly_budget / 30));

      // 1. Claude Opus — Google Search strategy
      const stratPrompt = `You are a Google Ads expert. Return ONLY valid JSON, no markdown.

Create a Google Search Ads campaign for ${biz.business_name} (${biz.industry}).
Goal: ${biz.marketing_goal || 'generate leads'} | Budget: $${monthly_budget}/month | Location: ${biz.location || 'United States'}
Target audience: ${biz.target_audience || 'general consumers'} | Tone: ${biz.brand_tone || 'professional'}
Landing page: ${finalUrl}

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
      const adGroups = strategy.ad_groups || [];
      const campName =
        strategy.campaign_name || `${biz.business_name} — Search — ${new Date().toISOString().slice(0, 10)}`;

      // 2. Create Campaign Budget
      const budgetResp = await googleAdsReq('POST', `customers/${customerId}/campaignBudgets:mutate`, token, {
        operations: [
          {
            create: {
              name: `${campName} Budget`,
              amountMicros: String(dailyBudget * 1_000_000),
              deliveryMethod: 'STANDARD',
            },
          },
        ],
      });

      if (budgetResp.status !== 200)
        throw new Error(`Budget create failed: ${JSON.stringify(budgetResp.body).slice(0, 300)}`);
      const budgetResourceName = budgetResp.body?.results?.[0]?.resourceName || '';

      // 3. Create Campaign
      const campResp = await googleAdsReq('POST', `customers/${customerId}/campaigns:mutate`, token, {
        operations: [
          {
            create: {
              name: campName,
              status: 'PAUSED',
              advertisingChannelType: 'SEARCH',
              campaignBudget: budgetResourceName,
              networkSettings: {
                targetGoogleSearch: true,
                targetSearchNetwork: true,
                targetContentNetwork: false,
              },
              biddingStrategyType: 'MANUAL_CPC',
            },
          },
        ],
      });

      if (campResp.status !== 200)
        throw new Error(`Campaign create failed: ${JSON.stringify(campResp.body).slice(0, 300)}`);
      const campaignResourceName = campResp.body?.results?.[0]?.resourceName || '';
      const googleCampaignId = campaignResourceName.split('/').pop();

      // 4. Create Ad Groups, Ads, Keywords
      let firstAdGroupId = null;
      for (const ag of adGroups.slice(0, 2)) {
        // Ad Group
        const agResp = await googleAdsReq('POST', `customers/${customerId}/adGroups:mutate`, token, {
          operations: [
            {
              create: {
                name: ag.name || `Ad Group — ${biz.business_name}`,
                campaign: campaignResourceName,
                status: 'ENABLED',
                cpcBidMicros: String(Math.round((biz.target_cpc || 1.5) * 1_000_000)),
              },
            },
          ],
        });
        if (agResp.status !== 200) continue;
        const agResourceName = agResp.body?.results?.[0]?.resourceName || '';
        if (!firstAdGroupId) firstAdGroupId = agResourceName.split('/').pop();

        // Keywords
        const kwOps = (ag.keywords || []).map((kw) => ({
          create: {
            adGroup: agResourceName,
            status: 'ENABLED',
            keyword: { text: typeof kw === 'string' ? kw : kw.text, matchType: kw.match_type || 'BROAD' },
          },
        }));
        if (kwOps.length) {
          await googleAdsReq('POST', `customers/${customerId}/adGroupCriteria:mutate`, token, { operations: kwOps });
        }

        // Ads (Responsive Search Ads) — finalUrls is the business's real URL,
        // sourced from businesses.website_url (preflight refuses if unset).
        for (const ad of (ag.ads || []).slice(0, 2)) {
          const truncate = (s, n) => (s || '').slice(0, n);
          const adOp = {
            create: {
              adGroup: agResourceName,
              status: 'ENABLED',
              ad: {
                finalUrls: [finalUrl],
                responsiveSearchAd: {
                  headlines: [
                    { text: truncate(ad.headline1, 30) },
                    { text: truncate(ad.headline2, 30) },
                    { text: truncate(ad.headline3, 30) },
                  ].filter((h) => h.text),
                  descriptions: [{ text: truncate(ad.description1, 90) }, { text: truncate(ad.description2, 90) }].filter(
                    (d) => d.text
                  ),
                },
              },
            },
          };
          await googleAdsReq('POST', `customers/${customerId}/adGroupAds:mutate`, token, { operations: [adOp] });
        }
      }

      // 5. Save to ad_campaigns
      await sbPost('ad_campaigns', {
        business_id,
        platform: 'google',
        google_campaign_id: googleCampaignId,
        google_ad_group_id: firstAdGroupId || null,
        status: 'paused',
        daily_budget: dailyBudget,
        objective: 'SEARCH_LEADS',
        ai_strategy: strategy,
        creatives: adGroups.flatMap((ag) => (ag.ads || []).map((a) => ({ headline: a.headline1 }))),
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
    <tr><td style="padding:8px 12px;font-weight:600">Landing page</td><td style="padding:8px 12px">${finalUrl}</td></tr>
    <tr style="background:#f8fafc"><td style="padding:8px 12px;font-weight:600">Status</td><td style="padding:8px 12px">⏸️ Paused — awaiting review</td></tr>
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
    if (!business_id || !campaign_id) return res.status(400).json({ error: 'business_id and campaign_id required' });
    try {
      const camp = (
        await sbGet(
          'ad_campaigns',
          `id=eq.${encodeURIComponent(campaign_id)}&business_id=eq.${encodeURIComponent(business_id)}`,
        )
      )[0];
      if (!camp) return res.status(404).json({ error: 'Campaign not found' });
      if (camp.platform !== 'google') return res.status(400).json({ error: 'Not a Google campaign' });

      const biz = (
        await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(business_id)}&select=google_access_token,google_access_token_enc,google_ads_customer_id`,
        )
      )[0];
      const token = oauthCrypto.readToken(biz, 'google_access_token');
      if (!token) return res.status(400).json({ error: 'google_ads_not_connected' });

      const customerId = gCid(biz.google_ads_customer_id);
      const resourceName = `customers/${customerId}/campaigns/${camp.google_campaign_id}`;

      await googleAdsReq('POST', `customers/${customerId}/campaigns:mutate`, token, {
        operations: [{ update: { resourceName, status: 'ENABLED' }, updateMask: 'status' }],
      });

      await sbPatch('ad_campaigns', `id=eq.${encodeURIComponent(campaign_id)}`, { status: 'active' });
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
      const biz = (
        await sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(business_id)}&select=business_name,marketing_goal,target_cpc,avg_order_value,` +
            `google_access_token,google_access_token_enc,google_ads_customer_id`,
        )
      )[0];
      const token = biz ? oauthCrypto.readToken(biz, 'google_access_token') : null;
      if (!biz?.google_ads_customer_id || !token) return;

      const customerId = gCid(biz.google_ads_customer_id);
      const campaigns = await sbGet(
        'ad_campaigns',
        `business_id=eq.${encodeURIComponent(business_id)}&platform=eq.google&status=eq.active`,
      );

      let optimizedCount = 0;
      const actionsTaken = [];

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

          const perfResp = await googleAdsReq('POST', `customers/${customerId}/googleAds:searchStream`, token, {
            query: gaqlQuery,
          });

          if (perfResp.status !== 200) continue;

          const row = perfResp.body?.[0]?.results?.[0];
          if (!row) continue;

          const impressions = parseInt(row.metrics?.impressions || 0);
          const clicks = parseInt(row.metrics?.clicks || 0);
          const costMicros = parseInt(row.metrics?.costMicros || 0);
          const spend = costMicros / 1_000_000;
          const conversions = parseFloat(row.metrics?.conversions || 0);
          const ctr = parseFloat(row.metrics?.ctr || 0) * 100;
          const avgCpcMicros = parseInt(row.metrics?.averageCpc || 0);
          const cpc = avgCpcMicros / 1_000_000;
          const revenue = conversions * (biz.avg_order_value || 50);
          const roas = spend > 0 ? revenue / spend : 0;
          const targetCpc = parseFloat(biz.target_cpc || 2.0);

          // Update analytics snapshot
          const today = new Date().toISOString().slice(0, 10);
          try {
            await sbUpsert(
              'analytics_snapshots',
              {
                business_id,
                snapshot_date: today,
                platform: 'google_ads',
                impressions,
                clicks,
                engagement: Math.round(conversions),
              },
              'business_id,snapshot_date,platform'
            );
          } catch {
            /* non-critical */
          }

          // Claude Opus — optimization decision
          const decisionPrompt = `You are a Google Ads optimizer. What action should be taken?

Campaign: ${camp.google_campaign_id}
Spend (7d): $${spend.toFixed(2)} | Impressions: ${impressions} | Clicks: ${clicks}
CTR: ${ctr.toFixed(2)}% | CPC: $${cpc.toFixed(2)} | Conversions: ${conversions} | ROAS: ${roas.toFixed(2)}x
Target CPC: $${targetCpc.toFixed(2)} | Goal: ${biz.marketing_goal || 'grow leads'}

Rules: ROAS > 3 OR CTR > 5% → increase_budget (+20%). CTR < 1% AND spend > $5 → decrease_budget (-20%).
CPC > target * 2 AND spend > $10 → decrease_budget (-30%). 0 conv AND spend > $30 AND CTR < 0.5% → pause.
ROAS < 1 AND spend > $20 → refresh_creative. Otherwise → keep.

Return ONLY JSON: {"action":"increase_budget"|"decrease_budget"|"pause"|"refresh_creative"|"keep","reason":"string","budget_change_pct":0}`;

          const decision = await callClaude(decisionPrompt, 'strategy', 400);
          const action = decision.action || 'keep';
          const reason = decision.reason || 'Performance within normal range';
          const changePct = decision.budget_change_pct || 0;

          // Execute action via Google Ads API
          if (action === 'increase_budget' || action === 'decrease_budget') {
            const currentBudget = camp.daily_budget || 10;
            const newBudget = Math.max(1, Math.round(currentBudget * (1 + changePct / 100)));
            // Update campaign budget (need the budget resource name)
            const budgetResourceName = `customers/${customerId}/campaignBudgets/${camp.google_campaign_id}`;
            await googleAdsReq('POST', `customers/${customerId}/campaignBudgets:mutate`, token, {
              operations: [
                {
                  update: {
                    resourceName: budgetResourceName,
                    amountMicros: String(newBudget * 1_000_000),
                  },
                  updateMask: 'amountMicros',
                },
              ],
            });
            await sbPatch('ad_campaigns', `id=eq.${encodeURIComponent(camp.id)}`, { daily_budget: newBudget });
          } else if (action === 'pause') {
            await googleAdsReq('POST', `customers/${customerId}/campaigns:mutate`, token, {
              operations: [
                {
                  update: {
                    resourceName: `customers/${customerId}/campaigns/${camp.google_campaign_id}`,
                    status: 'PAUSED',
                  },
                  updateMask: 'status',
                },
              ],
            });
          }

          await sbPatch('ad_campaigns', `id=eq.${encodeURIComponent(camp.id)}`, {
            last_decision: action,
            last_decision_reason: reason,
            last_optimized_at: new Date().toISOString(),
            impressions,
            clicks,
            total_spend: spend,
            roas,
            ...(action === 'pause' ? { status: 'paused', paused_reason: reason } : {}),
          });

          actionsTaken.push({ campaign_id: camp.id, action, reason });
          optimizedCount++;
        } catch (ce) {
          log('/webhook/google-campaign-optimize', `Campaign ${camp.id} error: ${ce.message}`);
          await logError(business_id, 'google-campaign-optimize', ce.message, { campaign_id: camp.id });
        }
      }
      log(
        '/webhook/google-campaign-optimize',
        `✅ Optimized ${optimizedCount}/${campaigns.length} Google campaigns for ${business_id}`
      );
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
      const campaigns = await sbGet(
        'ad_campaigns',
        `business_id=eq.${encodeURIComponent(business_id)}&platform=eq.google&order=created_at.desc`,
      );
      const summary = {
        total: campaigns.length,
        active: campaigns.filter((c) => c.status === 'active').length,
        paused: campaigns.filter((c) => c.status === 'paused').length,
        total_spend: campaigns.reduce((a, c) => a + parseFloat(c.total_spend || 0), 0).toFixed(2),
        avg_roas: campaigns.length
          ? (campaigns.reduce((a, c) => a + parseFloat(c.roas || 0), 0) / campaigns.length).toFixed(2)
          : '0.00',
      };
      res.json({ campaigns, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
