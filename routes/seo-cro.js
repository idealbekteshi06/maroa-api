'use strict';

/**
 * routes/seo-cro.js — SEO autopilot + CRO engine.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4.
 *
 *   POST /webhook/seo-audit                  — keyword gaps + meta tags +
 *                                               schema audit, async.
 *   GET  /webhook/seo-recommendations-get    — list pending recommendations.
 *   POST /webhook/seo-recommendation-apply   — flip recommendation status to applied.
 *   POST /webhook/cro-analyze                — page-scrape + Claude UX/CRO audit.
 *   POST /webhook/cro-generate-copy          — generate above-the-fold rewrite.
 *
 * HTML parser helpers (extractMetaTag, extractTitle, hasLdJsonSchema) live
 * in this module since they were only used by seo-audit.
 *
 * Behavior unchanged. Dep injection for testability.
 */

function register({
  app,
  sbGet,
  sbPost,
  sbPatch,
  callClaude,
  apiRequest,
  log,
  logError,
  storeInsight,
  SERPAPI_KEY,
  serpSearch,
  isUUID,
  getBrandExamples,
}) {
  // ── HTML parser helpers ─────────────────────────────────────────────────
  function extractMetaTag(html, name) {
    const m =
      html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'));
    return m ? m[1].trim() : null;
  }
  function extractTitle(html) {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  }
  function hasLdJsonSchema(html, type) {
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    return scripts.some((s) => {
      try {
        const d = JSON.parse(s[1]);
        return (d['@type'] || '').toLowerCase().includes(type.toLowerCase());
      } catch {
        return false;
      }
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
        const bizArr = await sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,location,website_url,target_audience,competitors`
        );
        const biz = bizArr[0];
        if (!biz) return;
        if (!biz.website_url) {
          log('/webhook/seo-audit', `No website_url for ${business_id}`);
          return;
        }

        let competitors = [];
        try {
          competitors = JSON.parse(biz.competitors || '[]');
        } catch {
          /* soft-fail */
        }

        let created = 0;
        const saveRec = async (
          type,
          current_value,
          recommended_value,
          target_keyword,
          priority,
          estimated_impact,
          url
        ) => {
          try {
            await sbPost('seo_recommendations', {
              business_id,
              url: url || biz.website_url,
              type,
              current_value: (current_value || '').slice(0, 500),
              recommended_value: (recommended_value || '').slice(0, 500),
              target_keyword,
              priority,
              estimated_impact,
            });
            created++;
          } catch (e) {
            log('/webhook/seo-audit', `saveRec error: ${e.message}`);
          }
        };

        // ── CHECK 1: Keyword gap + LOCAL SEO via SerpAPI ──────────────────────
        const kwGapPromise = (async () => {
          if (!SERPAPI_KEY) return;
          try {
            const loc = biz.location || '';
            const baseQuery = `${biz.industry} ${loc}`.trim();
            const bizResults = await serpSearch(baseQuery, 10);
            const bizLinks = new Set(bizResults.map((r) => r.link));

            for (const comp of competitors.slice(0, 3)) {
              const compName = typeof comp === 'string' ? comp : comp.name || comp;
              const compQ = `${compName} ${biz.industry}`;
              const compRes = await serpSearch(compQ, 10);
              for (const r of compRes) {
                if (!bizLinks.has(r.link) && r.title) {
                  const kw = r.title.split(' ').slice(0, 5).join(' ');
                  await saveRec(
                    'keyword_gap',
                    null,
                    `Target this keyword: "${kw}" — competitor ${compName} ranks here`,
                    kw,
                    'high',
                    '+15-30% organic traffic',
                    biz.website_url
                  );
                }
              }
            }
            // Also add the base keyword if site doesn't rank
            if (
              !bizResults.some((r) =>
                (r.link || '').includes((biz.website_url || '').replace(/https?:\/\//, '').split('/')[0])
              )
            ) {
              await saveRec(
                'keyword_gap',
                null,
                `Optimise homepage for: "${baseQuery}"`,
                baseQuery,
                'high',
                '+20% local organic traffic',
                biz.website_url
              );
            }

            // ── LOCAL SEO: geo-specific keyword gaps ────────────────────────────
            if (loc) {
              const localQueries = [
                `${biz.industry} in ${loc}`,
                `${biz.industry} near me`,
                `best ${biz.industry} ${loc}`,
              ];
              for (const lq of localQueries) {
                const lRes = await serpSearch(lq, 5);
                const domain = (biz.website_url || '').replace(/https?:\/\//, '').split('/')[0];
                const isRanking = lRes.some((r) => (r.link || '').includes(domain));
                if (!isRanking) {
                  await saveRec(
                    'local_seo',
                    null,
                    `Target local keyword: "${lq}" — not currently ranking`,
                    lq,
                    'high',
                    '+25% local discovery traffic',
                    biz.website_url
                  );
                }
              }
            }
          } catch (e) {
            log('/webhook/seo-audit', `kwGap error: ${e.message}`);
          }
        })();

        // ── CHECK 2: Meta tag audit ───────────────────────────────────────────
        const metaPromise = (async () => {
          try {
            const fetchResp = await apiRequest(
              'GET',
              biz.website_url.startsWith('http') ? biz.website_url : `https://${biz.website_url}`,
              {}
            );
            const html = typeof fetchResp.body === 'string' ? fetchResp.body : JSON.stringify(fetchResp.body);

            const currentTitle = extractTitle(html);
            const currentDesc = extractMetaTag(html, 'description');
            const baseKw = `${biz.industry} ${biz.location || ''}`.trim();

            const needsTitle = !currentTitle || currentTitle.length > 60 || currentTitle.length < 10;
            const needsDesc = !currentDesc || currentDesc.length > 155 || currentDesc.length < 50;

            if (needsTitle || needsDesc) {
              const metaPrompt = `Write an SEO-optimized meta title (max 60 chars) and meta description (max 155 chars) for ${biz.business_name} (${biz.industry}).
  Website: ${biz.website_url} | Target keyword: "${baseKw}" | Location: ${biz.location || 'United States'}
  Make the title include the keyword. Make the description include a clear benefit + CTA.
  Return ONLY valid JSON: { "meta_title": "...", "meta_description": "..." }`;
              const meta = await callClaude(metaPrompt, 'short_copy', 300);

              if (needsTitle)
                await saveRec(
                  'meta_title',
                  currentTitle || '(missing)',
                  meta.meta_title || '',
                  baseKw,
                  'high',
                  '+5-10% CTR in search results',
                  biz.website_url
                );
              if (needsDesc)
                await saveRec(
                  'meta_description',
                  currentDesc || '(missing)',
                  meta.meta_description || '',
                  baseKw,
                  'high',
                  '+3-8% CTR in search results',
                  biz.website_url
                );
            }
          } catch (e) {
            log('/webhook/seo-audit', `meta error: ${e.message}`);
          }
        })();

        // ── CHECK 3: Schema markup ────────────────────────────────────────────
        const schemaPromise = (async () => {
          try {
            const fetchResp = await apiRequest(
              'GET',
              biz.website_url.startsWith('http') ? biz.website_url : `https://${biz.website_url}`,
              {}
            );
            const html = typeof fetchResp.body === 'string' ? fetchResp.body : '';
            if (!hasLdJsonSchema(html, 'LocalBusiness') && !hasLdJsonSchema(html, 'Organization')) {
              const schemaPrompt = `Generate a complete LocalBusiness JSON-LD schema for:
  Business: ${biz.business_name}, Type: ${biz.industry}
  Phone: ${biz.phone || 'N/A'}, Website: ${biz.website_url}
  Address: ${biz.location || 'United States'}
  Return ONLY the raw JSON-LD object (no markdown, no \`\`\`).`;
              const schemaResult = await callClaude(schemaPrompt, 'short_copy', 600);
              const schemaText = JSON.stringify(schemaResult);
              await saveRec(
                'schema',
                '(no LocalBusiness schema found)',
                `<script type="application/ld+json">${schemaText}</script>`,
                null,
                'medium',
                '+local SEO + rich results eligibility',
                biz.website_url
              );
            }
          } catch (e) {
            log('/webhook/seo-audit', `schema error: ${e.message}`);
          }
        })();

        await Promise.all([kwGapPromise, metaPromise, schemaPromise]);
        try {
          storeInsight(
            business_id,
            'seo',
            'seo_intelligence',
            'recommendations_created',
            `${created} SEO recommendations`
          );
        } catch {
          /* soft-fail */
        }
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
      if (status) filter += `&status=eq.${status}`;
      if (priority) filter += `&priority=eq.${priority}`;

      const recs = await sbGet('seo_recommendations', filter);

      // Sort high → medium → low client-side
      const order = { high: 0, medium: 1, low: 2 };
      recs.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));

      const summary = {
        total: recs.length,
        pending: recs.filter((r) => r.status === 'pending').length,
        applied: recs.filter((r) => r.status === 'applied').length,
        by_type: recs.reduce((acc, r) => {
          acc[r.type] = (acc[r.type] || 0) + 1;
          return acc;
        }, {}),
        by_priority: {
          high: recs.filter((r) => r.priority === 'high').length,
          medium: recs.filter((r) => r.priority === 'medium').length,
          low: recs.filter((r) => r.priority === 'low').length,
        },
      };

      res.json({ recommendations: recs, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/seo-recommendation-apply
  // Mark a recommendation applied; return full details for frontend to show.
  // Body: { business_id, recommendation_id }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/seo-recommendation-apply', async (req, res) => {
    const { business_id, recommendation_id } = req.body;
    if (!recommendation_id || !business_id)
      return res.status(400).json({ error: 'recommendation_id and business_id required' });
    if (!isUUID(recommendation_id)) return res.status(400).json({ error: 'recommendation_id must be a valid UUID' });
    // The /webhook owner gate already verifies the caller owns business_id; bind
    // the recommendation to it so a foreign recommendation_id can't be applied.
    const filter = `id=eq.${encodeURIComponent(recommendation_id)}&business_id=eq.${encodeURIComponent(business_id)}`;
    try {
      await sbPatch('seo_recommendations', filter, { status: 'applied' });
      const rows = await sbGet('seo_recommendations', filter);
      res.json({ success: true, recommendation: rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
      const bizArr = await sbGet(
        'businesses',
        `id=eq.${business_id}&select=business_name,industry,marketing_goal,target_audience,website_url,brand_tone`
      );
      const biz = bizArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });

      const prompt = `You are a CRO expert. Analyze this business and generate 3 high-impact A/B tests.
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
      const testArr = Array.isArray(tests) ? tests : tests.tests || [];

      // Save each test to ab_tests table
      const saved = [];
      for (const t of testArr.slice(0, 3)) {
        try {
          const row = await sbPost('ab_tests', {
            business_id,
            variant_a: t.variant_a || '',
            variant_b: t.variant_b || '',
            variant_c: JSON.stringify({
              page: t.page,
              element: t.element,
              hypothesis: t.hypothesis,
              expected_lift: t.expected_lift,
              priority: t.priority,
            }),
          });
          saved.push({ ...t, id: row?.id });
        } catch {
          saved.push(t);
        }
      }

      res.json({ tests_created: saved.length, tests: saved });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
      const bizArr = await sbGet(
        'businesses',
        `id=eq.${business_id}&select=business_name,industry,target_audience,brand_tone,marketing_goal`
      );
      const biz = bizArr[0];
      if (!biz) return res.status(404).json({ error: 'business not found' });

      // Retrieve brand voice context
      const brandContext = await getBrandExamples(
        business_id,
        'social_post',
        `${biz.business_name} ${page_type} ${element_type}`
      );

      const prompt = `${brandContext}Write 3 distinct variations of a ${element_type} for the ${page_type} page of ${biz.business_name} (${biz.industry}).
  Goal: ${goal || biz.marketing_goal || 'convert visitors'} | Audience: ${biz.target_audience || 'general consumers'} | Tone: ${biz.brand_tone || 'professional'}
  Each variation should use a different psychological angle (e.g. urgency, social proof, curiosity).
  Return ONLY valid JSON: { "variations": [{ "text": "...", "rationale": "why this angle works" }] }`;

      const result = await callClaude(prompt, 'social_post', 800);
      const variations = result.variations || (Array.isArray(result) ? result : []);

      res.json({ variations, count: variations.length, page_type, element_type });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
