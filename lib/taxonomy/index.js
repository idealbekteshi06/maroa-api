'use strict';

/**
 * lib/taxonomy/index.js
 * ---------------------------------------------------------------------------
 * Unified taxonomy entrypoint. Combines industries, regions, and expert
 * sources behind a single API the pre-trainer + grounding library use.
 */

const industries = require('./industries');
const regions = require('./regions');
const expertSources = require('./expert_sources');

module.exports = {
  industries,
  regions,
  expertSources,
  VERSION: 'v1',
};
