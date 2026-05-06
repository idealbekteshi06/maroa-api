'use strict';

/**
 * services/weekly-scorecard/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts weekly-scorecard endpoints:
 *
 *   POST /webhook/weekly-scorecard-all   cron target — Sundays 22:00 UTC
 *   POST /webhook/weekly-scorecard-one   on-demand single-business generation
 * ----------------------------------------------------------------------------
 */

function registerScorecardRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/weekly-scorecard-all', async (req, res) => {
    const { dryRun } = req.body || {};
    try {
      const result = await engine.generateForAll({ dryRun: !!dryRun });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/weekly-scorecard-all', null, 'cron failed', e);
      apiError(res, 500, 'WEEKLY_SCORECARD_CRON_FAILED', e.message);
    }
  });

  app.post('/webhook/weekly-scorecard-one', async (req, res) => {
    const { businessId, dryRun, sendEmailToOwner } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.generateForBusiness({
        businessId,
        dryRun: !!dryRun,
        sendEmailToOwner: sendEmailToOwner !== false,
      });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/weekly-scorecard-one', businessId, 'gen failed', e);
      apiError(res, 500, 'WEEKLY_SCORECARD_FAILED', e.message);
    }
  });
}

module.exports = { registerScorecardRoutes };
