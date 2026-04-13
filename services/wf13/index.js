/*
 * services/wf13/index.js
 * ----------------------------------------------------------------------------
 * Factory for WF13 — Weekly Strategy Brief.
 * ----------------------------------------------------------------------------
 */

'use strict';

const { buildBrandContext } = require('../wf1/brandContext.js');
const createAggregator = require('./contextBundle.js');
const createEngine = require('./engine.js');

function createWf13(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    countryIntelligence,
    logger,
    sendEmail,
    sendWhatsApp,
  } = deps;

  if (!sbGet || !callClaude) throw new Error('WF13: sbGet + callClaude required');

  const aggregator = createAggregator({ sbGet, countryIntelligence, logger });
  const engine = createEngine({
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    logger,
    aggregator,
    buildBrandContext,
    sendEmail,
    sendWhatsApp,
  });

  return { engine, aggregator };
}

module.exports = createWf13;
