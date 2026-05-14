'use strict';

/**
 * routes/content-workflow.js — blog/landing/video_script content engine.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4.
 *
 *   POST /webhook/content-generate     — generate blog / landing_page /
 *                                         video_script / email_template
 *                                         via Claude. Runs async.
 *   GET  /webhook/content-pieces-get   — list pieces + status filter.
 *   POST /webhook/content-approve      — flip status to approved + log.
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
  sendEmail,
  log,
  logError,
  SERPAPI_KEY,
  generateSmartImage,
  isUUID,
}) {
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/content-generate
  // Generate blog / landing_page / video_script via Claude + optionally image.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/content-generate', async (req, res) => {
    const { business_id, type = 'blog', target_keyword, topic } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!['blog', 'landing_page', 'video_script', 'email_template'].includes(type))
      return res.status(400).json({ error: 'type must be blog|landing_page|video_script|email_template' });
  
    // Return immediately — generation happens in background
    res.json({ received: true, message: `${type} generation started — check email in ~2 minutes` });
  
    setImmediate(async () => {
      try {
        const bizArr = await sbGet(
          'businesses',
          `id=eq.${business_id}&select=business_name,industry,location,target_audience,brand_tone,marketing_goal,email,first_name`
        );
        const biz = bizArr[0];
        if (!biz) return;
  
        let keyword = target_keyword;
        // Auto-discover keyword via SerpAPI if not provided (blog only)
        if (type === 'blog' && !keyword && SERPAPI_KEY) {
          try {
            const sr = await apiRequest(
              'GET',
              `https://serpapi.com/search.json?q=${encodeURIComponent(`${biz.industry} tips`)}&num=10&api_key=${SERPAPI_KEY}`
            );
            const queries = sr.body?.related_searches || [];
            keyword = queries[0]?.query || `${biz.industry} tips for ${biz.target_audience || 'small businesses'}`;
          } catch {
            keyword = `${biz.industry} tips for ${biz.target_audience || 'businesses'}`;
          }
        }
        keyword = keyword || topic || `${biz.industry} guide`;
  
        let prompt = '';
        let claudeTask = 'strategy';
        let maxTok = 3000;
  
        if (type === 'blog') {
          prompt = `Write a complete SEO blog post for ${biz.business_name} (${biz.industry}).
  Target keyword: "${keyword}"
  Tone: ${biz.brand_tone || 'professional'} | Location: ${biz.location || 'United States'}
  
  Write 1200-1500 words with H1 title, H2 subheadings, intro, body sections, conclusion, and CTA.
  Return ONLY valid JSON:
  {
    "title": "H1 headline with keyword",
    "body": "full blog post in plain text with section headers marked as ## Header",
    "meta_description": "155-char max SEO meta description",
    "seo_score": 75,
    "word_count": 1300
  }`;
        } else if (type === 'landing_page') {
          prompt = `Write complete landing page copy for ${biz.business_name} (${biz.industry}).
  Goal: ${biz.marketing_goal || 'generate leads'} | Audience: ${biz.target_audience || 'general consumers'}
  Tone: ${biz.brand_tone || 'professional'}
  
  Sections: Hero headline + subheadline, 3 key benefits, social proof placeholder, 3-question FAQ, CTA section.
  Return ONLY valid JSON:
  {
    "title": "page headline",
    "body": "full landing page copy with section breaks",
    "meta_description": "155-char meta description",
    "seo_score": 70,
    "word_count": 800
  }`;
        } else if (type === 'video_script') {
          claudeTask = 'social_post';
          maxTok = 1500;
          prompt = `Write a 60-second video script for ${biz.business_name} (${biz.industry}).
  Format: Hook(0-5s), Problem(5-15s), Solution(15-40s), Proof(40-50s), CTA(50-60s).
  Tone: ${biz.brand_tone || 'energetic'} | Audience: ${biz.target_audience || 'small business owners'}
  
  Return ONLY valid JSON:
  {
    "title": "video title for YouTube/TikTok",
    "body": "full script with timestamps e.g. [0-5s] Hook: ...",
    "meta_description": "video description for YouTube (250 chars)",
    "seo_score": 65,
    "word_count": 200
  }`;
        } else {
          // email_template
          claudeTask = 'email';
          maxTok = 1200;
          prompt = `Write a marketing email template for ${biz.business_name} (${biz.industry}).
  Goal: ${biz.marketing_goal || 'nurture leads'} | Tone: ${biz.brand_tone || 'friendly'}
  
  Return ONLY valid JSON:
  {
    "title": "email subject line",
    "body": "full email body in plain text",
    "meta_description": "email preview text (90 chars max)",
    "seo_score": 60,
    "word_count": 350
  }`;
        }
  
        const content = await callClaude(prompt, claudeTask, maxTok);
  
        // Generate featured image for blog posts → save to Supabase Storage
        let featured_image_url = null;
        if (type === 'blog' && content.title) {
          try {
            const imgResult = await generateSmartImage(
              business_id,
              `Professional blog header image for: ${content.title}. ${biz.industry} themed, modern, clean.`,
              'blog_featured',
              biz.plan || 'free'
            );
            featured_image_url = imgResult?.url || null;
          } catch {
            /* soft-fail */
          }
        }
  
        // Save to content_pieces
        const piece = await sbPost('content_pieces', {
          business_id,
          type,
          title: content.title || keyword,
          target_keyword: keyword,
          body: content.body || '',
          meta_description: content.meta_description || '',
          featured_image_url,
          status: 'ready_for_review',
          word_count: content.word_count || 0,
          seo_score: content.seo_score || 0,
        });
  
        // Send notification email
        if (biz.email) {
          const typeLabel = type.replace('_', ' ');
          const html = `
  <h2>New ${typeLabel} ready for review</h2>
  <p><strong>Title:</strong> ${content.title || keyword}</p>
  <p><strong>Word count:</strong> ${content.word_count || 0} words</p>
  <p><strong>SEO score:</strong> ${content.seo_score || 0}/100</p>
  <p><a href="https://maroa.ai/content" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Review & Approve</a></p>`;
          await sendEmail(biz.email, `New ${typeLabel} ready: ${content.title || keyword}`, html).catch(() => {});
        }
  
        log('/webhook/content-generate', `✅ ${type} created | id: ${piece?.id} | words: ${content.word_count}`);
      } catch (err) {
        console.error('[content-generate ERROR]', err.message);
        await logError(business_id, 'content-generate', err.message, req.body).catch(() => {});
      }
    });
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/content-pieces-get?business_id=X[&type=X][&status=X]
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/content-pieces-get', async (req, res) => {
    const { business_id, type, status, limit = 20, offset = 0 } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      let filter = `business_id=eq.${business_id}&order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (type) filter += `&type=eq.${type}`;
      if (status) filter += `&status=eq.${status}`;
      const pieces = await sbGet('content_pieces', filter);
      const summary = {
        total: pieces.length,
        by_type: pieces.reduce((a, p) => {
          a[p.type] = (a[p.type] || 0) + 1;
          return a;
        }, {}),
        by_status: pieces.reduce((a, p) => {
          a[p.status] = (a[p.status] || 0) + 1;
          return a;
        }, {}),
        avg_seo_score: pieces.length ? Math.round(pieces.reduce((s, p) => s + (p.seo_score || 0), 0) / pieces.length) : 0,
        avg_word_count: pieces.length
          ? Math.round(pieces.reduce((s, p) => s + (p.word_count || 0), 0) / pieces.length)
          : 0,
      };
      res.json({ pieces, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/content-approve
  // Approve a content piece and optionally mark it published.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/content-approve', async (req, res) => {
    const piece_id = req.body.piece_id || req.body.content_id;
    const { published_url } = req.body;
    if (!piece_id) return res.status(400).json({ error: 'piece_id required' });
    if (!isUUID(piece_id)) return res.status(400).json({ error: 'piece_id must be a valid UUID' });
    try {
      const updates = { status: published_url ? 'published' : 'approved' };
      if (published_url) updates.published_url = published_url;
      await sbPatch('content_pieces', `id=eq.${piece_id}`, updates);
      res.json({ success: true, piece_id, status: updates.status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
