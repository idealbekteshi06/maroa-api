'use strict';

/**
 * services/ai-seo/index.js
 * ----------------------------------------------------------------------------
 * AI-SEO service factory. New user-facing capability — gets customer sites
 * cited in ChatGPT / Perplexity / Google AI Overviews / Claude / Gemini.
 * ----------------------------------------------------------------------------
 */

const createEngine = require('./engine');
const { registerAiSeoRoutes } = require('./registerRoutes');

function createAiSeo(deps) {
  const engine = createEngine(deps);
  function registerRoutes({ app, apiError }) {
    registerAiSeoRoutes({ app, apiError, engine, logger: deps.logger });
  }
  return { engine, registerRoutes };
}

module.exports = createAiSeo;
