'use strict';

/**
 * lib/marketingClaude.js
 * Unified marketing LLM calls: Sonnet 4.6 executor + Opus advisor + gated web search.
 */

const advisor = require('../services/prompts/advisor-tool');
const { checkWebSearchBudget, recordWebSearchUse } = require('./webSearchGate');

/**
 * @param {object} opts
 * @param {Function} opts.callClaude
 * @param {Function} [opts.sbGet]
 * @param {Function} [opts.sbPost]
 * @param {object} [opts.logger]
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {string} opts.task — advisor task id (audit, competitor, strategy, …)
 * @param {string} opts.planTier
 * @param {string} [opts.businessId]
 * @param {string} opts.skill — llm_cost_logs skill label
 * @param {number} [opts.max_tokens]
 * @param {string} [opts.model] — override executor
 * @param {boolean|'auto'|number} [opts.webSearch] — false off; number = max_uses; auto = plan default
 * @param {boolean} [opts.cacheSystem]
 * @param {string} [opts.cacheTtl] — '5m' | '1h' for batch-heavy prompts
 * @param {boolean} [opts.returnRaw]
 * @param {string} [opts.budget] — advisor budget (standard | quick | deep)
 */
async function callMarketingClaude(opts = {}) {
  const {
    callClaude,
    sbGet,
    sbPost,
    logger,
    system,
    user,
    task,
    planTier,
    businessId,
    skill,
    max_tokens,
    model,
    webSearch = 'auto',
    cacheSystem = true,
    cacheTtl,
    returnRaw = true,
    budget = 'standard',
    extra = {},
  } = opts;

  if (typeof callClaude !== 'function') throw new Error('callMarketingClaude: callClaude required');

  const plan = String(planTier || 'starter').toLowerCase();
  const models = advisor.modelsFor(plan);
  const composedExtra = {
    businessId,
    cacheSystem,
    cacheTtl,
    skill: skill || task || 'marketing',
    returnRaw,
    ...extra,
  };

  if (webSearch !== false && businessId && sbGet && ['growth', 'agency'].includes(plan)) {
    const gate = await checkWebSearchBudget({ businessId, sbGet, plan });
    if (gate.allowed) {
      const maxUses = typeof webSearch === 'number' ? webSearch : plan === 'agency' ? 5 : 3;
      composedExtra.webSearch = {
        max_uses: maxUses,
        dynamicFilter: plan === 'agency',
      };
    }
  }

  const useAdvisor = advisor.shouldUseAdvisor({ task, planTier: plan, budget }) && models.advisor;

  let result;
  if (useAdvisor) {
    result = await advisor.callWithAdvisor({
      callClaude,
      system,
      user,
      task,
      planTier: plan,
      budget,
      executor: model || models.executor,
      advisor: models.advisor,
      max_tokens,
      extra: composedExtra,
    });
  } else {
    result = await callClaude({
      system,
      user,
      model: model || models.executor,
      max_tokens,
      extra: composedExtra,
    });
  }

  if (composedExtra.webSearch && businessId && sbPost) {
    await recordWebSearchUse({ businessId, count: 1, sbPost, logger });
  }

  if (returnRaw && result && typeof result === 'object' && !Array.isArray(result) && result._raw) {
    return result._raw;
  }
  return result;
}

module.exports = { callMarketingClaude };
