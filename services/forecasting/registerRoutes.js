'use strict';

/**
 * services/forecasting/registerRoutes.js
 *   POST /webhook/forecast    Generate forecast for a business
 */

function registerForecastingRoutes({ app, apiError, engine, logger }) {
  app.post('/webhook/forecast', async (req, res) => {
    const { businessId, horizonDays } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const result = await engine.forecast({ businessId, horizonDays: Number(horizonDays) || undefined });
      res.json(result);
    } catch (e) {
      logger?.error?.('/webhook/forecast', businessId, 'forecast failed', e);
      apiError(res, 500, 'FORECAST_FAILED', e.message);
    }
  });
}

module.exports = { registerForecastingRoutes };
