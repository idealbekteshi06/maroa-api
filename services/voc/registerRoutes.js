'use strict';

/**
 * services/voc/registerRoutes.js
 *   POST /webhook/voc-synthesize     Synthesize from pre-fetched sources
 *   POST /webhook/voc-auto           Auto-fetch + synthesize (uses biz tokens)
 */

function registerVocRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/voc-synthesize', async (req, res) => {
    const { businessId, google, facebook, instagram, email, knownCompetitors } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.synthesize({ businessId, google, facebook, instagram, email, knownCompetitors });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/voc-synthesize', businessId, 'synth failed', e);
      apiError(res, 500, 'VOC_SYNTH_FAILED', e.message);
    }
  });

  app.post('/webhook/voc-auto', async (req, res) => {
    const { businessId, knownCompetitors, recentPostIds } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.fetchAndSynthesize({ businessId, knownCompetitors, recentPostIds });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/voc-auto', businessId, 'auto-synth failed', e);
      apiError(res, 500, 'VOC_AUTO_FAILED', e.message);
    }
  });
}

module.exports = { registerVocRoutes };
