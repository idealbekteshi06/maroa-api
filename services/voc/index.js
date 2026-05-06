'use strict';

/**
 * services/voc/index.js
 * VOC service factory.
 */

const createEngine = require('./engine');
const { registerVocRoutes } = require('./registerRoutes');

function createVoc(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerVocRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createVoc;
