'use strict';

/**
 * services/pacing-alerts/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts pacing-alerts endpoints:
 *
 *   POST /webhook/pacing-alerts-evaluate-all   cron target — every 4 hours
 *   POST /webhook/pacing-alerts-evaluate-one   on-demand single-campaign check
 * ----------------------------------------------------------------------------
 */

function registerPacingRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/pacing-alerts-evaluate-all', async (req, res) => {
    const { dryRun, limit } = req.body || {};
    try {
      const result = await engine.evaluateAll({ dryRun: !!dryRun, limit: Number(limit || 500) });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/pacing-alerts-evaluate-all', null, 'cron failed', e);
      apiError(res, 500, 'PACING_ALERTS_CRON_FAILED', e.message);
    }
  });

  app.post('/webhook/pacing-alerts-evaluate-one', async (req, res) => {
    const { campaignId, businessId, dryRun } = req.body || {};
    if (!campaignId || !businessId) return apiError(res, 400, 'INVALID_REQUEST', 'campaignId + businessId required');
    try {
      const result = await engine.evaluateOne({ campaignId, businessId, dryRun: !!dryRun });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/pacing-alerts-evaluate-one', businessId, 'eval failed', e);
      apiError(res, 500, 'PACING_ALERTS_FAILED', e.message);
    }
  });
}

module.exports = { registerPacingRoutes };
