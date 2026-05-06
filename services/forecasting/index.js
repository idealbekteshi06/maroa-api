'use strict';

/**
 * services/forecasting/index.js
 * Forecasting service factory.
 */

const createEngine = require('./engine');
const { registerForecastingRoutes } = require('./registerRoutes');

function createForecasting(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerForecastingRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createForecasting;
