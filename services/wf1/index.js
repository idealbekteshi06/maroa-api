/*
 * services/wf1/index.js
 * ----------------------------------------------------------------------------
 * Single factory that wires every WF1 service together with the helpers
 * provided by server.js. Server.js does:
 *
 *   const wf1 = require('./services/wf1')({
 *     sbGet, sbPost, sbPatch,
 *     callClaude, extractJSON,
 *     apiRequest,
 *     serpSearch,
 *     countryIntelligence: require('./services/countryIntelligence'),
 *     checkOrchestrationIdempotency,
 *     recordOrchestrationTaskRun,
 *     logger,
 *   });
 *
 * Then mounts the endpoints: wf1.registerRoutes(app) (see registerRoutes.js).
 * ----------------------------------------------------------------------------
 */

'use strict';

const { buildBrandContext } = require('./brandContext.js');
const createContextBundleBuilder = require('./contextBundle.js');
const createGuardrails = require('./guardrails.js');
const createEngine = require('./engine.js');
const createPublisher = require('./publish.js');
const createLearningLoop = require('./learningLoop.js');
const createDailyRun = require('./dailyRun.js');

function createWf1(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    apiRequest, serpSearch,
    countryIntelligence,
    checkOrchestrationIdempotency,
    recordOrchestrationTaskRun,
    logger,
  } = deps;

  if (!sbGet || !sbPost || !sbPatch) throw new Error('WF1: sbGet/sbPost/sbPatch required');
  if (!callClaude) throw new Error('WF1: callClaude required');
  if (!extractJSON) throw new Error('WF1: extractJSON required');

  const contextBundleBuilder = createContextBundleBuilder({ sbGet, serpSearch, countryIntelligence, logger });
  const guardrails = createGuardrails({ sbGet, countryIntelligence, logger });
  const engine = createEngine({
    sbGet, sbPost, sbPatch,
    callClaude, extractJSON,
    logger,
    contextBundleBuilder,
    guardrails,
    buildBrandContext,
  });
  const publisher = createPublisher({ apiRequest, sbGet, sbPost, sbPatch, logger });
  const learningLoop = createLearningLoop({ sbGet, sbPost, sbPatch, apiRequest, logger });
  const dailyRun = createDailyRun({
    sbGet, sbPost, sbPatch, logger,
    engine,
    publisher,
    checkOrchestrationIdempotency,
    recordOrchestrationTaskRun,
  });

  return { engine, publisher, learningLoop, dailyRun, guardrails, contextBundleBuilder, buildBrandContext };
}

module.exports = createWf1;
