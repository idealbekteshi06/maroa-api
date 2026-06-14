'use strict';

/**
 * services/oauth/registerTokenRefreshRoutes.js
 * ---------------------------------------------------------------------------
 * Mounts the proactive OAuth token-refresh routes (feature #2 rebuild):
 *
 *   POST /webhook/oauth-token-refresh-all   cron target — refresh every due
 *                                           connected account (LinkedIn/X/TikTok)
 *   POST /webhook/oauth-token-refresh       on-demand — refresh one business
 *
 * Driven by the Inngest cron `oauth-token-refresh-hourly`. Registered on the
 * internal dispatcher too, so the cron skips the HTTP loopback in-process.
 * ---------------------------------------------------------------------------
 */

const tokenRefresh = require('./tokenRefresh');

function registerTokenRefreshRoutes({ app, apiError, sbGet, sbPatch, logger }) {
  const internalDispatcher = require('../../lib/internalDispatcher');
  const deps = { sbGet, sbPatch, logger };

  function runAll() {
    return tokenRefresh.refreshAllDue({ deps });
  }
  internalDispatcher.register('/webhook/oauth-token-refresh-all', () => runAll());

  app.post('/webhook/oauth-token-refresh-all', async (req, res) => {
    try {
      res.json(await runAll());
    } catch (e) {
      apiError(res, 500, 'OAUTH_TOKEN_REFRESH_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/oauth-token-refresh', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const rows = await sbGet('businesses', `id=eq.${encodeURIComponent(businessId)}&select=*`);
      if (!rows || !rows[0]) return apiError(res, 404, 'NOT_FOUND', 'business not found');
      const results = await tokenRefresh.refreshBusiness({ business: rows[0], deps });
      res.json({ ok: true, businessId, results });
    } catch (e) {
      apiError(res, 500, 'OAUTH_TOKEN_REFRESH_FAILED', e.message);
    }
  });
}

module.exports = { registerTokenRefreshRoutes };
