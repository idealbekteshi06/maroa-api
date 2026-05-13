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

const { limits } = require('../../lib/rateLimiters');
const internalDispatcher = require('../../lib/internalDispatcher');

function registerPacingRoutes({ app, apiError, engine, logger }) {
  // ─── /webhook/pacing-alerts-evaluate-all ───────────────────────────────
  // Registered with both Express (HTTP) AND the in-process dispatcher so
  // Inngest's every-4-hour cron skips loopback. See ADR-0006.
  async function evaluateAll({ dryRun, limit }) {
    return engine.evaluateAll({ dryRun: !!dryRun, limit: Number(limit || 500) });
  }
  internalDispatcher.register('/webhook/pacing-alerts-evaluate-all', (body) => evaluateAll(body || {}));

  app.post('/webhook/pacing-alerts-evaluate-all', limits.crontarget, async (req, res) => {
    try {
      const result = await evaluateAll(req.body || {});
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/pacing-alerts-evaluate-all', null, 'cron failed', e);
      apiError(res, 500, 'PACING_ALERTS_CRON_FAILED', e.message);
    }
  });

  app.post('/webhook/pacing-alerts-evaluate-one', limits.standardMutate, async (req, res) => {
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
