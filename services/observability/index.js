'use strict';

/**
 * services/observability/index.js
 * Public entry — re-exports logger + metrics + cost tracker.
 */

const logger = require('./logger');
const metrics = require('./metrics');
const costTracker = require('./cost-tracker');

module.exports = {
  // Logger
  makeLogger: logger.makeLogger,
  // Metrics
  metrics,
  // Cost tracker
  costTracker,
  // Express middleware
  metricsMiddleware: metrics.expressMiddleware,
};
