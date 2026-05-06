'use strict';

/**
 * services/weekly-scorecard/index.js
 * ----------------------------------------------------------------------------
 * Weekly Scorecard service factory.
 * ----------------------------------------------------------------------------
 */

const createEngine = require('./engine');
const { registerScorecardRoutes } = require('./registerRoutes');

function createWeeklyScorecard(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerScorecardRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createWeeklyScorecard;
