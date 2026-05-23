'use strict';

/**
 * routes/competitor-intel.js — competitor analysis + report read.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up).
 *
 *   POST /webhook/competitor-analyze    — full intelligence run for one
 *                                          business: SerpAPI for top 5 competitors,
 *                                          page-scrape, Claude synthesis, email digest.
 *   GET  /webhook/competitor-report-get — fetch the most recent report row.
 *
 * Behavior unchanged. Dep injection for testability.
 */

function register({ app, sbGet, sbPost, callClaude, apiRequest, sendEmail, log, logError, SERPAPI_KEY }) {
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
        const bizArr = await sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,location,competitors,email,first_name`
        );
        const biz = bizArr[0];
        if (!biz) return;

        let competitors = [];
        try {
          competitors = JSON.parse(biz.competitors || '[]');
        } catch {
          /* soft-fail */
        }
        if (!competitors.length) {
          // Fall back to SerpAPI to find top competitors
          if (SERPAPI_KEY) {
            try {
              const sr = await apiRequest(
                'GET',
                `https://serpapi.com/search.json?q=${encodeURIComponent(`${biz.industry} competitors ${biz.location || ''}`)}&num=5&api_key=${SERPAPI_KEY}`
              );
              const organic = sr.body?.organic_results || [];
              competitors = organic
                .slice(0, 3)
                .map((r) => r.displayed_link || r.link)
                .filter(Boolean);
            } catch {
              /* soft-fail */
            }
          }
          if (!competitors.length) competitors = [`top ${biz.industry} company`];
        }

        const snapshots = [];
        const today = new Date().toISOString().split('T')[0];

        for (const comp of competitors.slice(0, 5)) {
          const compName = typeof comp === 'string' ? comp : comp.name || comp;
          let serpData = {},
            adData = {};

          // SerpAPI: brand search
          if (SERPAPI_KEY) {
            try {
              const sr = await apiRequest(
                'GET',
                `https://serpapi.com/search.json?q=${encodeURIComponent(compName)}&num=5&api_key=${SERPAPI_KEY}`
              );
              serpData = sr.body || {};
            } catch {
              /* soft-fail */
            }
            // SerpAPI: ad search
            try {
              const ar = await apiRequest(
                'GET',
                `https://serpapi.com/search.json?q=${encodeURIComponent(`${compName} ads`)}&num=5&api_key=${SERPAPI_KEY}`
              );
              adData = ar.body || {};
            } catch {
              /* soft-fail */
            }
          }

          const keyword_rankings = (serpData.organic_results || []).slice(0, 5).map((r) => ({
            keyword: r.title?.slice(0, 60),
            url: r.link,
            position: r.position,
          }));
          const active_ads = (adData.ads || []).slice(0, 5).map((a) => ({
            headline: a.title,
            description: a.snippet,
            url: a.link,
          }));

          // Save snapshot
          try {
            await sbPost('competitor_snapshots', {
              business_id,
              competitor_name: compName,
              snapshot_date: today,
              keyword_rankings,
              active_ads,
            });
          } catch {
            /* soft-fail */
          }

          snapshots.push({ name: compName, keyword_rankings, active_ads });
        }

        // Claude Opus — competitive intelligence analysis
        const analyzePrompt = `You are a competitive intelligence analyst for ${biz.business_name} (${biz.industry}).
  
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
          business_id,
          report_date: today,
          new_offers: analysis.new_offers || [],
          content_themes: analysis.content_themes || [],
          ad_angles: analysis.ad_angles || [],
          pricing_changes: analysis.pricing_changes || [],
          recommendation: analysis.recommendation || '',
          raw_analysis: analysis,
        });

        // Also update legacy competitor_insights table
        try {
          await sbPost('competitor_insights', {
            business_id,
            competitor_doing_well: (analysis.ad_angles || []).join('; ').slice(0, 300),
            gap_opportunity: (analysis.content_themes || []).join('; ').slice(0, 300),
            content_to_steal: (analysis.new_offers || []).join('; ').slice(0, 300),
            positioning_tip: analysis.recommendation || '',
          });
        } catch {
          /* soft-fail */
        }

        log('/webhook/competitor-analyze', `✅ ${snapshots.length} competitors analyzed | report: ${report?.id}`);
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
        sbGet('competitor_snapshots', `business_id=eq.${business_id}&order=snapshot_date.desc&limit=10`),
      ]);
      res.json({ latest_report: reports[0] || null, recent_reports: reports, recent_snapshots: snapshots });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
