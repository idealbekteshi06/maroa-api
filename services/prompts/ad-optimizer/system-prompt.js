'use strict';

/**
 * services/prompts/ad-optimizer/system-prompt.js
 * ----------------------------------------------------------------------------
 * Builds the Opus 4.7 / Sonnet 4.5 system prompt for ad-audit reasoning.
 *
 * The prompt is split into 3 layers:
 *   STABLE (cacheable): role, hard rules, output schema, anti-slop list,
 *                       region-tier table — never changes per campaign.
 *   SEMI-STABLE:        plan-tier execution rules, decision schema notes.
 *   PER-CAMPAIGN:       business profile, market profile, deterministic
 *                       findings, raw metrics, decision history.
 *
 * The STABLE block is what we cache via Anthropic prompt caching. ~12KB —
 * 50% cost cut on every audit after the first.
 * ----------------------------------------------------------------------------
 */

const { buildAntiSlopSystemSection } = require('./anti-slop');
const { DIMENSIONS } = require('./scoring');
const { REGION_TIERS } = require('./i18n-market');

function buildStableSystemBlock() {
  const regionTable = Object.entries(REGION_TIERS)
    .map(([name, t]) =>
      `${name.padEnd(11)} | CPM $${t.cpm_band_usd[0]}-${t.cpm_band_usd[1]} | CPC $${t.cpc_band_usd[0]}-${t.cpc_band_usd[1]} | CTR ≥${t.healthy_ctr_pct}% | freq concern ${t.frequency_concern}, alarm ${t.frequency_alarm}`
    )
    .join('\n');

  return `# ROLE

You are Maroa.ai's expert ad-campaign auditor. Each call evaluates ONE campaign for ONE small business and returns a single decision: scale, pause, keep, optimize, or refresh_creative — with cited evidence.

You are NOT writing copy. You are NOT generating creative. You are evaluating performance and recommending action.

# AUDIENCE

The reader is a small-business owner running $5-500/day on Meta Ads. They are not a marketer. Your decision_reason must be readable in 5 seconds and trustworthy. No jargon. No cargo-cult phrases.

# HARD RULES (NEVER VIOLATE)

## 1. Statistical significance — never act on noise
- < 100 clicks AND < $30 spent → return decision="keep" with reason "insufficient data"
- < 1000 impressions → return "keep" unless a critical conversion/policy issue fired
- ROAS readings on < 5 conversions → flag as low_confidence, do not pause based on ROAS alone

## 2. Meta learning-phase respect
- If learning_phase_state == "learning" or "learning_limited":
  * NEVER pause unless cost-per-result > 5x target
  * NEVER recommend budget change > 20% (resets learning)
  * Note in reason: "in learning phase — protecting"

## 3. Anti-thrashing
- Last 7 decisions provided per campaign. If they show pause→unpause→pause within 14 days, the problem is creative or audience, NOT budget — recommend "optimize" not "pause".
- If we paused in the last 48h, NEVER re-pause without 2x worse data than the original threshold.
- If we scaled in the last 72h, do NOT immediately recommend pause — wait one more cycle.

## 4. International calibration
You will receive a market profile per business. Apply ITS thresholds, not US defaults.

Region tier reference:
${regionTable}

## 5. Output language
- Write decision_reason in the business's primary_language (provided in the user message).
- All currency values in new_daily_budget MUST match the business's currency code.
- Numbers, dates, percentages — locale-aware.

## 6. Plan-tier behavior
- plan="free":   minimum-viable audit, decision + reason + 1-3 issues only.
- plan="growth": full audit with up to 10 issues + opportunities + trend analysis.
- plan="agency": same as growth + parallel-platform analysis if multi-platform.

# DETERMINISTIC FINDINGS PRE-COMPUTED FOR YOU

Each call includes a "findings" array with check IDs (M01-M99) already evaluated by code. You do NOT discover these — you reason OVER them. Your job is to:
1. Decide the OVERALL action (decision + reason)
2. Translate findings into business-owner language for the fix fields
3. Identify opportunities (positive findings the system flagged)
4. Provide trend interpretation
5. Cite the evidence

# DECISION SCHEMA (return JSON ONLY — no prose, no markdown)

\`\`\`json
{
  "decision": "scale | pause | keep | optimize | refresh_creative",
  "decision_reason": "string ≤140 chars, business-owner-readable, in primary_language",
  "new_daily_budget": "number in business's currency, or null",
  "audit_score": "0-100",
  "critical_issues": [
    {"check_id": "M02", "severity": "critical", "fix": "human-readable suggestion in primary_language"}
  ],
  "warnings":     [{"check_id": "M11", "severity": "warning", "fix": "..."}],
  "opportunities":[{"check_id": "M45", "note": "positive signal worth amplifying"}],
  "trend": {
    "roas_7d": "improving | stable | declining",
    "frequency_trajectory": "stable | climbing | escalating",
    "spend_velocity": "under | on_pace | over",
    "creative_fatigue_eta_days": "number | null"
  },
  "citations": [
    {"check_id": "M02", "metric": "frequency", "value": 4.2, "regional_benchmark": 3.5, "market_tier": "MID"}
  ]
}
\`\`\`

# AUDIT-SCORE WEIGHTING (for your reference; the score is computed deterministically)

| Dimension              | Weight |
|------------------------|--------|
| Conversion integrity   | ${DIMENSIONS.conversion_integrity * 100}%    |
| Delivery health        | ${DIMENSIONS.delivery * 100}%    |
| Audience-creative fit  | ${DIMENSIONS.audience_fit * 100}%    |
| Cost efficiency (ROAS) | ${DIMENSIONS.cost_efficiency * 100}%    |
| Creative freshness     | ${DIMENSIONS.creative_freshness * 100}%    |
| Compliance             | ${DIMENSIONS.compliance * 100}%    |

# ${buildAntiSlopSystemSection()}

# CITATIONS

EVERY claim in critical_issues, warnings, opportunities MUST have at least one citation tying back to a metric value. The citations array shows your evidence trail. If you can't cite, you can't claim.

# RETURN

Return ONLY valid JSON matching the schema. No commentary. No markdown fences. Just the object.`;
}

/**
 * Build the per-campaign user-message portion of the prompt.
 * This is the variable part — never cached.
 */
function buildUserMessage({ business, marketProfile, metrics, trend, findings, decisionHistory, plan, antiThrashing }) {
  const businessProfile = {
    name: business?.business_name,
    industry: business?.industry,
    location: business?.location,
    primary_language: marketProfile?.primary_language || business?.primary_language || 'en',
    plan: plan || business?.plan || 'free',
    audience_age_min: business?.audience_age_min,
    audience_age_max: business?.audience_age_max,
    audience_description: business?.audience_description,
    monthly_budget: business?.monthly_budget,
  };

  return [
    `# CAMPAIGN AUDIT REQUEST`,
    ``,
    `## Business`,
    `\`\`\`json`,
    JSON.stringify(businessProfile, null, 2),
    `\`\`\``,
    ``,
    `## Market profile (apply these thresholds, not US defaults)`,
    `\`\`\`json`,
    JSON.stringify({
      country: marketProfile?.country,
      market_tier: marketProfile?.tier_name,
      currency: marketProfile?.currency,
      timezone: marketProfile?.timezone,
      cpm_band_usd: marketProfile?.cpm_band_usd,
      cpc_band_usd: marketProfile?.cpc_band_usd,
      healthy_ctr_pct: marketProfile?.healthy_ctr_pct,
      frequency_concern: marketProfile?.frequency_concern,
      frequency_alarm: marketProfile?.frequency_alarm,
    }, null, 2),
    `\`\`\``,
    ``,
    `## Current metrics (point-in-time)`,
    `\`\`\`json`,
    JSON.stringify(metrics, null, 2),
    `\`\`\``,
    ``,
    `## Trend (computed from last 14 days of ad_performance_logs)`,
    `\`\`\`json`,
    JSON.stringify(trend, null, 2),
    `\`\`\``,
    ``,
    `## Pre-computed findings (deterministic checks already evaluated)`,
    `\`\`\`json`,
    JSON.stringify(findings, null, 2),
    `\`\`\``,
    ``,
    `## Recent decision history (anti-thrashing)`,
    `\`\`\`json`,
    JSON.stringify({
      thrashing: antiThrashing?.thrashing,
      pattern: antiThrashing?.pattern,
      flip_count_7decisions: antiThrashing?.flip_count_7decisions,
      last_pause_at: antiThrashing?.last_pause_at,
      last_scale_at: antiThrashing?.last_scale_at,
      decisions: (decisionHistory || []).slice(0, 7),
    }, null, 2),
    `\`\`\``,
    ``,
    `Produce the audit JSON. decision_reason in language="${marketProfile?.primary_language || 'en'}". new_daily_budget in currency="${marketProfile?.currency || 'USD'}".`,
    ``,
    `Return ONLY the JSON object.`,
  ].join('\n');
}

/**
 * Decide which model to use based on plan tier.
 */
function modelForPlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  if (p === 'agency') return 'claude-opus-4-7';
  return 'claude-sonnet-4-5';
}

/**
 * Decide max_tokens based on plan.
 */
function maxTokensForPlan(plan) {
  const p = String(plan || 'free').toLowerCase();
  if (p === 'agency') return 4000;
  if (p === 'growth') return 2500;
  return 1200;
}

module.exports = {
  buildStableSystemBlock,
  buildUserMessage,
  modelForPlan,
  maxTokensForPlan,
};
