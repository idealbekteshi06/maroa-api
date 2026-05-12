'use strict';

/**
 * routes/ai-seo.js — AI SEO optimization endpoint.
 *
 * Public endpoint:
 *   POST /api/ai-seo/optimize   — generate FAQ + authority paragraphs +
 *                                 target queries for AI search engines
 *                                 (ChatGPT / Perplexity / Google AI Overviews)
 *
 * Carved from server.js per the routes/waitlist.js pattern.
 */

function register({ app, getProfile, callClaude, pCity, claudeBiz, sbPost, storeInsight, log }) {
  app.post('/api/ai-seo/optimize', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Generating AI SEO content' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const result = await callClaude(
          `You are an AI SEO expert for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nUSP: ${p.usp}\nLanguage: ${p.primary_language}\n\nOptimize for ChatGPT, Perplexity, Google AI Overviews:\n1. Create 10 FAQ entries (question as users ask AI + direct citable answer)\n2. Write 3 authority paragraphs (specific numbers, structured for extraction)\n3. Generate local search queries\n\nReturn ONLY valid JSON:\n{"faqs":[{"question":"string","answer":"string"}],"authority_paragraphs":["string"],"target_queries":["string"]}`,
          'research',
          2000,
          claudeBiz(userId)
        );
        await sbPost('ai_seo_content', {
          user_id: userId,
          content_type: 'full_optimization',
          optimized_content: JSON.stringify(result),
        });
        storeInsight(userId, 'ai_seo', 'seo', 'target_queries', (result.target_queries || []).slice(0, 5).join('; '));
        log('/api/ai-seo/optimize', `✅ AI SEO content for ${p.business_name}`);
      } catch (err) {
        console.error('[ai-seo]', err.message);
      }
    });
  });
}

module.exports = { register };
