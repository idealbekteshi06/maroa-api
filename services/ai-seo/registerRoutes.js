'use strict';

/**
 * services/ai-seo/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts AI-SEO endpoints:
 *
 *   POST /webhook/ai-seo-audit       Run an audit for one business
 *   POST /webhook/ai-seo-generate    Generate llms.txt + schemas + rewrites
 * ----------------------------------------------------------------------------
 */

function registerAiSeoRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/ai-seo-audit', async (req, res) => {
    const { businessId, html, text, llms_txt_present, llms_full_txt_present } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.auditOne({ businessId, html, text, llms_txt_present, llms_full_txt_present });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/ai-seo-audit', businessId, 'audit failed', e);
      apiError(res, 500, 'AI_SEO_AUDIT_FAILED', e.message);
    }
  });

  app.post('/webhook/ai-seo-generate', async (req, res) => {
    const { businessId, pages } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.generate({ businessId, pages: Array.isArray(pages) ? pages : [] });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/ai-seo-generate', businessId, 'generate failed', e);
      apiError(res, 500, 'AI_SEO_GENERATE_FAILED', e.message);
    }
  });
}

module.exports = { registerAiSeoRoutes };
