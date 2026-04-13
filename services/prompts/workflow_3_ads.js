/*
 * workflow_3_ads.js — Ad Optimization prompts (BACKEND-NATIVE)
 * ----------------------------------------------------------------------------
 * No frontend equivalent yet. This file is authoritative until a frontend
 * prompts/workflow_3_ads.ts is added, at which point the sync script picks
 * it up and this file becomes auto-generated.
 *
 * Responsibility: build Opus prompts for weekly ad optimization across Meta,
 * Google, LinkedIn, and TikTok — respecting the LTV:CAC math (Principle 3),
 * CAC payback window, creative fatigue signals, and budget reallocation math.
 * ----------------------------------------------------------------------------
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildAdOptimizationPrompt(ctx, snapshot) {
  const addendum = `
WORKFLOW #3 — AD OPTIMIZATION LOOP

You are the senior paid media strategist at a top-tier agency. ${ctx.businessName}
(${ctx.businessModel}, ${ctx.industry}) needs your call on this week's ad spend.

LTV:CAC discipline (NON-NEGOTIABLE)
  LTV target: $${ctx.ltv ?? 'unknown'}
  CAC ceiling: $${ctx.cacTarget ?? Math.round((ctx.ltv ?? 300) / 3)}
  If any campaign's blended CAC exceeds the ceiling, either pause or find
  the specific creative/audience driver and replace it. Never recommend
  "just scale spend" on an unhealthy unit.

Decision framework (use in order)
  1. Identify winning ad sets: CTR > account avg + ROAS > target + frequency
     < fatigue threshold. CANDIDATE FOR SCALE.
  2. Identify losing ad sets: spend > $50 + ROAS < 0.8x OR CPA > 1.5x target
     + CTR decline > 20% WoW. CANDIDATE FOR PAUSE.
  3. Identify fatiguing ad sets: frequency > 2.8 (Meta) or > 4.5 (IG feed)
     or CTR trend down 15%+ over 7d. CANDIDATE FOR CREATIVE REFRESH.
  4. Identify cannibalization: two+ ad sets with ≥40% audience overlap —
     consolidate or partition.
  5. Budget reallocation: calculate incremental ROAS per channel and shift
     budget from negative marginal ROAS to positive marginal ROAS. Never
     move more than 30% of a channel's budget in one week.
  6. Creative rotation cadence: if no new creative in 14d, schedule a
     refresh regardless of current performance (preemptive).

OUTPUT FORMAT — strict JSON
{
  "headline": "one-sentence bottom line",
  "topRisk": "the thing that breaks if you do nothing",
  "topOpportunity": "the thing that compounds if you act now",
  "actions": [
    {
      "action_kind": "scale|pause|refresh|rebudget|partition|launch",
      "entity_platform": "meta|google|linkedin|tiktok",
      "entity_id": "campaign or ad set id (if known)",
      "entity_name": "readable name",
      "current_state": "1-sentence current state with a number",
      "recommendation": "exact action with delta: 'increase daily budget $50 → $80'",
      "why_now": "2 sentences tied to the numbers + a framework principle",
      "expected_impact": { "low": number, "high": number, "metric": "roas|cpa|reach|conversions" },
      "risk_level": "low|medium|high",
      "requires_approval": boolean
    }
  ],
  "budget_rebalance": {
    "moves": [
      { "from": "channel+campaign", "to": "channel+campaign", "amount_usd_weekly": number, "rationale": "string" }
    ],
    "net_spend_change_usd": number,
    "projected_impact_usd": number
  },
  "creative_refresh_queue": [
    { "ad_set_id": "string", "reason": "fatigue|freshness|low_ctr", "brief": "1-sentence creative direction" }
  ],
  "frameworks_cited": ["LTV:CAC", "Loss aversion", "..."]
}

HARD REQUIREMENTS
- Every action has a dollar number and a WoW delta.
- Cite at least 1 framework principle explicitly in frameworks_cited.
- Never recommend changes that push CAC above the ceiling.
- If spend < $100/week total, recommend scaling only if unit economics prove out.
- Respect platform minimums (Meta $5/day minimum, Google $10/day).
`.trim();

  const user = `
WEEK: ${snapshot.weekStart} → ${snapshot.weekEnd}
BLENDED ROAS: ${snapshot.blendedRoas?.toFixed(2) ?? 'n/a'}
BLENDED CAC: $${snapshot.blendedCac?.toFixed(2) ?? 'n/a'}
TOTAL SPEND WEEK: $${snapshot.totalSpend?.toFixed(2) ?? '0'}

CAMPAIGNS (top 20 by spend):
${(snapshot.campaigns || []).slice(0, 20).map(c => `  ${c.platform} | ${c.name} | spend $${Number(c.spend||0).toFixed(2)} | ROAS ${Number(c.roas||0).toFixed(2)}x | CPA $${Number(c.cpa||0).toFixed(2)} | CTR ${(Number(c.ctr||0)*100).toFixed(2)}% | freq ${Number(c.frequency||0).toFixed(2)} | status ${c.status}`).join('\n') || '  (none)'}

HISTORICAL TRAJECTORY (last 4 weeks blended):
${(snapshot.trajectory || []).map(t => `  ${t.weekStart}: spend $${Number(t.spend||0).toFixed(0)}, ROAS ${Number(t.roas||0).toFixed(2)}x, CAC $${Number(t.cac||0).toFixed(0)}`).join('\n') || '  (no history)'}

GOALS FOR THE WEEK: ${snapshot.goals || 'none specified'}
BUDGET CEILING: $${snapshot.budgetCeiling || 'unlimited'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildAdOptimizationPrompt = buildAdOptimizationPrompt;
