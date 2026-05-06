'use strict';

/**
 * services/ad-optimizer/index.js
 * ----------------------------------------------------------------------------
 * Service factory for the Daily Ad Optimizer (user-facing WF02).
 *
 * NOTE: services/wf2/ is already taken by Lead Scoring & Routing (different
 * internal numbering). This service implements the user-facing WF02 ad
 * optimizer described in CLAUDE.md.
 *
 * server.js wires this with:
 *
 *   const adOptimizer = require('./services/ad-optimizer')({
 *     sbGet, sbPost, sbPatch,
 *     callClaude, extractJSON,
 *     logger, Sentry,
 *   });
 *   adOptimizer.registerRoutes({ app, apiError });
 * ----------------------------------------------------------------------------
 */

const createEngine = require('./engine');
const { registerAdOptimizerRoutes } = require('./registerRoutes');

function createAdOptimizer(deps) {
  const engine = createEngine(deps);

  function registerRoutes({ app, apiError }) {
    registerAdOptimizerRoutes({
      app,
      apiError,
      engine,
      logger: deps.logger,
    });
  }

  return { engine, registerRoutes };
}

module.exports = createAdOptimizer;
