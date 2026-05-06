'use strict';

/**
 * services/prompts/decision-narrator/index.js
 * ----------------------------------------------------------------------------
 * Wraps any Maroa decision with a "show your work" narrative.
 *
 * Public API:
 *   narrate({ decision, context, business, plan, callClaude, extractJSON })
 *     → { what_we_saw, what_we_considered, why_we_chose, confidence,
 *         confidence_reason, what_we_expect, narrative_full }
 *     OR null if insufficient evidence
 *
 *   narrateAdDecision(audit, business, plan, ...)        — convenience wrapper
 *   narrateSeoDecision(audit, business, plan, ...)        — convenience wrapper
 *   narrateCroDecision(audit, business, plan, ...)        — convenience wrapper
 *   narrateForecastDecision(forecast, business, plan,...) — convenience wrapper
 *
 * The narrator is the LAST step before content ships — runs after the decision
 * is already made. Adds the "human consultant" feel without changing the
 * underlying logic.
 * ----------------------------------------------------------------------------
 */

const adI18n = require('../ad-optimizer/i18n-market');
const advisor = require('../advisor-tool');

// ─── System prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `# ROLE

You are Maroa's decision narrator. You take a structured decision (already made by deterministic logic + LLM) and write a 3-5 sentence narrative that explains it the way a top human marketing consultant would — concrete, honest, calibrated.

# AUDIENCE

Small-business owner. Reads in 5 seconds. Doesn't know jargon. Trusts you because you cite numbers.

# HARD RULES (NEVER VIOLATE)

## 1. Quote concrete numbers
Every claim must reference a real metric from the input findings. "ROAS at 1.8 over 14 days" not "ROAS declined". If you can't quote it, you can't say it.

## 2. Honest confidence
- "high" only when data is thick (14+ days, ≥30 conversions, low variance) AND decision aligns with deterministic findings
- "medium" when there's a real judgment call between options
- "low" when data is thin OR variance is high OR learning phase active

## 3. Show competing factors
Always include a "we considered X, but Y" beat. Real consultants think out loud.

## 4. No buzzwords
Strip: "leverage", "elevate", "world-class", "cutting-edge", "in today's...", "let's dive in". This is a quality-uplift skill — the OPPOSITE of slop.

## 5. Output language
narrative_full + all field text in business.primary_language. Numbers/dates in business locale.

## 6. ≤5 sentences in narrative_full
Total. Brief is trustworthy. Padding breaks trust.

## 7. If evidence is too thin, return null
If decision_input has no real findings to cite, return:
\`\`\`json
{ "skip": true, "reason": "insufficient_evidence" }
\`\`\`
Don't invent narrative without evidence.

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "what_we_saw": "<1-2 sentences with cited numbers>",
  "what_we_considered": "<1-2 sentences — competing factors>",
  "why_we_chose": "<1 sentence with the actual reason>",
  "confidence": "low | medium | high",
  "confidence_reason": "<why this confidence level>",
  "what_we_expect": "<1 sentence — outcome + threshold for re-deciding>",
  "narrative_full": "<3-5 sentences combining the above, primary_language>"
}
\`\`\`

OR if evidence too thin:

\`\`\`json
{ "skip": true, "reason": "insufficient_evidence" }
\`\`\`

Return ONLY the JSON.`;
}

function buildUserMessage({ decision, context, business, marketProfile, plan }) {
  return [
    `# DECISION NARRATION REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify({
      name: business?.business_name,
      industry: business?.industry,
      primary_language: marketProfile?.primary_language,
      currency: marketProfile?.currency,
      currency_symbol: marketProfile?.currency_symbol,
      plan,
    }, null, 2),
    '```',
    ``,
    `## Decision (already made)`,
    '```json',
    JSON.stringify(decision, null, 2),
    '```',
    ``,
    `## Context (deterministic findings, history, trend — quote from this)`,
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    ``,
    `Produce the JSON in language="${marketProfile?.primary_language || 'en'}". narrative_full ≤ 5 sentences. Return ONLY the JSON.`,
  ].join('\n');
}

// ─── Schema validator ──────────────────────────────────────────────────────

const VALID_CONFIDENCE = ['low', 'medium', 'high'];

function validateNarrative(raw) {
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };
  if (raw.skip === true) return { valid: true, normalized: null, skip: true, reason: raw.reason || 'unspecified' };

  const errors = [];
  for (const f of ['what_we_saw', 'why_we_chose', 'narrative_full']) {
    if (raw[f] != null && typeof raw[f] !== 'string') errors.push(`${f} must be string`);
  }
  if (raw.confidence && !VALID_CONFIDENCE.includes(raw.confidence)) {
    errors.push(`confidence must be ${VALID_CONFIDENCE.join('|')}`);
  }
  // narrative_full sentence count check (≤5)
  if (raw.narrative_full && countSentences(raw.narrative_full) > 6) {
    errors.push('narrative_full exceeds 5 sentences');
  }

  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    normalized: {
      what_we_saw: raw.what_we_saw || '',
      what_we_considered: raw.what_we_considered || '',
      why_we_chose: raw.why_we_chose || '',
      confidence: raw.confidence || 'medium',
      confidence_reason: raw.confidence_reason || '',
      what_we_expect: raw.what_we_expect || '',
      narrative_full: raw.narrative_full || '',
    },
  };
}

function countSentences(s) {
  if (!s) return 0;
  // Match sentence terminators ONLY when followed by whitespace or end-of-string.
  // This avoids counting periods inside decimals like "1.5" or "14.99".
  return (s.match(/[.!?]+(?=\s|$)/g) || []).length;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Narrate a decision. Returns null if evidence too thin.
 */
async function narrate(opts) {
  const {
    decision,
    context,
    business,
    plan = 'free',
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (!decision) return null;
  if (typeof callClaude !== 'function') throw new Error('narrate: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('narrate: extractJSON required');

  const planTier = String(plan || 'free').toLowerCase();
  const marketProfile = adI18n.buildMarketProfile(business);

  // Free tier: skip narration (cost protection — they get plain decision text)
  if (planTier === 'free') return null;

  // Cheap upfront sanity check — refuse to narrate empty decisions
  const hasFindings = Array.isArray(context?.findings) && context.findings.length > 0
                   || Array.isArray(context?.deterministic_findings) && context.deterministic_findings.length > 0
                   || Array.isArray(context?.critical_issues) && context.critical_issues.length > 0
                   || Array.isArray(context?.citations) && context.citations.length > 0;
  if (!hasFindings && !context?.metrics && !context?.trend) {
    return null; // honest skip
  }

  let raw;
  try {
    raw = await advisor.callWithAdvisor({
      callClaude,
      system: buildSystemPrompt(),
      user: buildUserMessage({ decision, context, business, marketProfile, plan: planTier }),
      executor: 'claude-sonnet-4-5',
      advisor: 'claude-opus-4-7',
      task: 'strategy',
      planTier,
      max_tokens: planTier === 'agency' ? 1200 : 800,
      extra: { cacheSystem: true },
      temperature: 0.3,
    });
  } catch (e) {
    logger?.warn?.('decision-narrator', null, 'LLM call failed', e?.message);
    return null;
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  const v = parsed ? validateNarrative(parsed) : { valid: false, errors: ['parse_error'] };
  if (!v.valid) {
    logger?.warn?.('decision-narrator', null, 'invalid output', v.errors);
    return null;
  }
  if (v.skip) return null;
  return v.normalized;
}

// ─── Convenience wrappers ──────────────────────────────────────────────────

async function narrateAdDecision(audit, business, plan, deps) {
  return narrate({
    decision: {
      action: audit.decision,
      reason: audit.decision_reason,
      new_daily_budget: audit.new_daily_budget,
      audit_score: audit.audit_score,
    },
    context: {
      findings: audit.deterministic_findings,
      critical_issues: audit.critical_issues,
      warnings: audit.warnings,
      trend: audit.trend,
      market_tier: audit.market_tier,
      budget_tier: audit.budget_tier,
      gates: audit.gates,
      citations: audit.citations,
    },
    business, plan, ...deps,
  });
}

async function narrateSeoDecision(audit, business, plan, deps) {
  return narrate({
    decision: {
      action: audit.ai_search_readiness,
      score: audit.audit_score,
      potential: audit.estimated_citation_potential,
    },
    context: {
      findings: audit.deterministic_findings,
      critical_issues: audit.critical_gaps,
      warnings: audit.warnings,
      dimension_scores: audit.dimension_scores,
      citations: audit.citations,
    },
    business, plan, ...deps,
  });
}

async function narrateCroDecision(audit, business, plan, deps) {
  return narrate({
    decision: {
      action: audit.expected_lift_band,
      score: audit.audit_score,
      conv_band: audit.current_estimated_conv_rate_band,
    },
    context: {
      findings: audit.deterministic_findings,
      critical_issues: audit.critical_issues,
      warnings: audit.warnings,
      dimension_scores: audit.dimension_scores,
      citations: audit.citations,
    },
    business, plan, ...deps,
  });
}

async function narrateForecastDecision(forecast, business, plan, deps) {
  return narrate({
    decision: {
      action: 'forecast',
      horizon: forecast.horizon_days,
      data_quality: forecast.data_quality,
    },
    context: {
      metrics: {
        roas: forecast.roas_forecast,
        revenue: forecast.revenue_forecast,
        ltv: forecast.ltv_forecast,
      },
      trend: forecast.budget_allocation_recommendation,
      sample_size_days: forecast.sample_size_days,
      caveats: forecast.caveats,
    },
    business, plan, ...deps,
  });
}

module.exports = {
  narrate,
  narrateAdDecision,
  narrateSeoDecision,
  narrateCroDecision,
  narrateForecastDecision,
  validateNarrative,
  countSentences,
};
