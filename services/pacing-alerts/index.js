'use strict';

/**
 * services/pacing-alerts/index.js
 * ----------------------------------------------------------------------------
 * Pacing Alerts service factory.
 * ----------------------------------------------------------------------------
 */

const createEngine = require('./engine');
const { registerPacingRoutes } = require('./registerRoutes');

function createPacingAlerts(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerPacingRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createPacingAlerts;
