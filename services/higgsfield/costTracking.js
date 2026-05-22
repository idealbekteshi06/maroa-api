'use strict';

/**
 * Higgsfield generation credit estimates → llm_cost_logs.
 */

const MODEL_COSTS = {
  'kling-3.0': { credits: 6, cost_usd: 0.06 },
  'kling 3.0': { credits: 6, cost_usd: 0.06 },
  'nano-banana-pro': { credits: 4, cost_usd: 0.04 },
  'nano banana pro': { credits: 4, cost_usd: 0.04 },
  'nan-banana-pro': { credits: 4, cost_usd: 0.04 },
  'wan-2.5': { credits: 8, cost_usd: 0.08 },
  'wan 2.5': { credits: 8, cost_usd: 0.08 },
  'veo-3.1': { credits: 50, cost_usd: 0.5 },
  'veo 3.1': { credits: 50, cost_usd: 0.5 },
  'sora-2': { credits: 60, cost_usd: 0.6 },
  'sora 2': { credits: 60, cost_usd: 0.6 },
};

const DEFAULT_COST = { credits: 4, cost_usd: 0.04 };

/** Mr. Higgs AI director shot-list call (Agency). */
const MR_HIGGS_COST = { credits: 3, cost_usd: 0.03 };

function estimateModelCost(modelSlugOrCanonical) {
  const key = String(modelSlugOrCanonical || '')
    .trim()
    .toLowerCase();
  return MODEL_COSTS[key] || DEFAULT_COST;
}

/**
 * Best-effort write to llm_cost_logs (same table as Anthropic cost tracker).
 */
async function logHiggsfieldGenerationCost(sbPost, opts = {}) {
  if (typeof sbPost !== 'function') return null;
  const modelKey = String(opts.model || opts.model_slug || 'higgsfield').toLowerCase();
  const est = estimateModelCost(modelKey);
  const credits = opts.credits_used != null ? opts.credits_used : est.credits;
  const costUsd = opts.cost_usd != null ? opts.cost_usd : est.cost_usd;
  const row = {
    business_id: opts.businessId || opts.business_id || null,
    skill: opts.skill || 'higgsfield_generation',
    model: `higgsfield:${modelKey}`,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: costUsd,
  };
  try {
    await sbPost('llm_cost_logs', row);
  } catch {
    /* observability must not break generation */
  }
  return { credits, cost_usd: costUsd, model: modelKey };
}

function estimateMrHiggsCost() {
  return { ...MR_HIGGS_COST };
}

async function logMrHiggsCost(sbPost, opts = {}) {
  const est = estimateMrHiggsCost();
  return logHiggsfieldGenerationCost(sbPost, {
    ...opts,
    model: 'mr-higgs-director',
    skill: opts.skill || 'mr_higgs_shot_list',
    credits_used: est.credits,
    cost_usd: est.cost_usd,
  });
}

module.exports = {
  MODEL_COSTS,
  MR_HIGGS_COST,
  estimateModelCost,
  estimateMrHiggsCost,
  logHiggsfieldGenerationCost,
  logMrHiggsCost,
};
