'use strict';

/**
 * services/cro/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts CRO endpoints:
 *
 *   POST /webhook/cro-audit     Audit a landing page
 *   POST /webhook/cro-rewrite   Rewrite hero / CTA / bullets
 * ----------------------------------------------------------------------------
 */

function registerCroRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/cro-audit', async (req, res) => {
    const { businessId, html, text } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.audit({ businessId, html, text });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/cro-audit', businessId, 'audit failed', e);
      apiError(res, 500, 'CRO_AUDIT_FAILED', e.message);
    }
  });

  app.post('/webhook/cro-rewrite', async (req, res) => {
    const { businessId, currentHero } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.rewrite({ businessId, currentHero });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/cro-rewrite', businessId, 'rewrite failed', e);
      apiError(res, 500, 'CRO_REWRITE_FAILED', e.message);
    }
  });
}

module.exports = { registerCroRoutes };
