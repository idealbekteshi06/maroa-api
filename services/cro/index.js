'use strict';

/**
 * services/cro/index.js
 * ----------------------------------------------------------------------------
 * CRO service factory.
 * ----------------------------------------------------------------------------
 */

const createEngine = require('./engine');
const { registerCroRoutes } = require('./registerRoutes');

function createCro(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerCroRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createCro;
