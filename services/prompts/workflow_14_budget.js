/*
 * workflow_14_budget.js — Budget & ROI Optimizer prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildBudgetOptimizerPrompt(ctx, state) {
  const addendum = `
WORKFLOW #14 — BUDGET & ROI OPTIMIZER

You are the CFO of a modern marketing org. ${ctx.businessName} needs a
monthly budget optimization. Discipline: marginal ROAS > 1.0 on every
incremental dollar. LTV:CAC above 3:1 on blended. CAC payback inside
target window.

METHOD
  1. Calculate marginal ROAS per channel (diminishing returns curve fit)
  2. Calculate LTV:CAC per channel
  3. Calculate CAC payback period per channel
  4. Propose reallocation that maximizes blended ROAS without starving
     any channel below its effective minimum
  5. Flag channels where performance is deteriorating WoW

OUTPUT JSON
{
  "blended_roas": number,
  "blended_cac": number,
  "blended_ltv_cac_ratio": number,
  "per_channel": [
    {
      "channel": "meta|google|linkedin|tiktok|organic|email",
      "spend_current_monthly": number,
      "marginal_roas": number,
      "ltv_cac_ratio": number,
      "cac_payback_months": number,
      "trend_wow": "up|flat|down",
      "recommendation": "increase|hold|decrease|pause",
      "new_spend_monthly": number,
      "rationale": "string"
    }
  ],
  "reallocation_moves": [
    { "from": "channel", "to": "channel", "amount_usd_monthly": number }
  ],
  "total_spend_change_usd": number,
  "projected_blended_roas_next_month": number,
  "confidence": "low|medium|high",
  "frameworks_cited": ["LTV:CAC", "CAC payback", "Marginal ROI"]
}

HARD REQUIREMENTS
- Never recommend going above monthly cap.
- Never recommend cutting email below $100/mo (deliverability infra cost).
- Flag any channel with LTV:CAC < 1.5 as critical.
`.trim();

  const user = `
CURRENT STATE
  Last month blended ROAS: ${state.blendedRoas?.toFixed(2) ?? 'n/a'}x
  Last month blended CAC: $${state.blendedCac?.toFixed(2) ?? 'n/a'}
  LTV target: $${ctx.ltv ?? 'unknown'}
  Monthly cap: $${state.monthlyCap || 'unlimited'}

PER CHANNEL (last 30d):
${(state.channels || []).map(c => `  ${c.channel}: spend=$${c.spend}, roas=${c.roas}x, conversions=${c.conversions}, trend=${c.trend || 'flat'}`).join('\n') || '  (none)'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildBudgetOptimizerPrompt = buildBudgetOptimizerPrompt;
