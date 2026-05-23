'use strict';

/**
 * lib/llmGateway.js — unified LLM budget enforcement for every Claude call.
 *
 * Two independent gates (both must pass unless opted out):
 *   1. Daily call count — checkTokenBudgetForBusiness (orchestration_logs / Redis)
 *   2. Monthly USD cap   — costGuard.checkCostCap (llm_cost_logs)
 */

const { checkCostCap } = require('./costGuard');

class LLMBudgetExceededError extends Error {
  constructor(message, code = 'AI_BUDGET_EXCEEDED', status = 402) {
    super(message);
    this.name = 'LLMBudgetExceededError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.businessId
 * @param {Function} opts.sbGet
 * @param {Function} opts.checkTokenBudgetForBusiness — injected from server.js
 * @param {boolean} [opts.skipBudget] — skip daily call cap
 * @param {boolean} [opts.skipCostCap] — skip monthly USD cap
 */
async function enforceLLMBudget({
  businessId,
  sbGet,
  checkTokenBudgetForBusiness,
  skipBudget = false,
  skipCostCap = false,
}) {
  if (!businessId) return { allowed: true, maxTokensPerCall: 4000 };

  if (!skipBudget && typeof checkTokenBudgetForBusiness === 'function') {
    const daily = await checkTokenBudgetForBusiness(businessId);
    if (!daily.allowed) {
      throw new LLMBudgetExceededError(daily.reason || 'Daily AI call limit reached', 'AI_BUDGET_EXCEEDED', 402);
    }
    if (!skipCostCap && sbGet) {
      const monthly = await checkCostCap({ businessId, sbGet });
      if (!monthly.allowed) {
        throw new LLMBudgetExceededError(
          monthly.reason || `Monthly AI spend cap reached ($${monthly.used_usd}/${monthly.cap_usd})`,
          'AI_COST_CAP_EXCEEDED',
          402
        );
      }
      return {
        allowed: true,
        maxTokensPerCall: daily.maxTokensPerCall,
        plan: monthly.plan,
        used_usd: monthly.used_usd,
        cap_usd: monthly.cap_usd,
      };
    }
    return { allowed: true, maxTokensPerCall: daily.maxTokensPerCall };
  }

  if (!skipCostCap && sbGet) {
    const monthly = await checkCostCap({ businessId, sbGet });
    if (!monthly.allowed) {
      throw new LLMBudgetExceededError(monthly.reason || 'Monthly AI spend cap reached', 'AI_COST_CAP_EXCEEDED', 402);
    }
    return {
      allowed: true,
      maxTokensPerCall: 4000,
      plan: monthly.plan,
      used_usd: monthly.used_usd,
      cap_usd: monthly.cap_usd,
    };
  }

  return { allowed: true, maxTokensPerCall: 4000 };
}

module.exports = {
  enforceLLMBudget,
  LLMBudgetExceededError,
};
