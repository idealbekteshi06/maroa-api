'use strict';

/**
 * services/prompts/email-design/index.js
 * Public exports for email-design layer.
 */

const charts = require('./svg-charts');
const templates = require('./templates');

module.exports = {
  charts,
  templates,
  // Convenience top-level
  scorecard: templates.scorecard,
  adAuditSummary: templates.adAuditSummary,
  brandColor: templates.brandColor,
  sparkline: charts.sparkline,
  bar: charts.bar,
  gauge: charts.gauge,
  donut: charts.donut,
};
