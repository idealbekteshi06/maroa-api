'use strict';

/**
 * services/prompts/ad-optimizer/index.js
 * ----------------------------------------------------------------------------
 * Public entry point for the ad-optimizer prompt module. Exposes:
 *
 *   buildAuditInputs({ business, metrics, history, decisionHistory, plan })
 *     → { marketProfile, trend, findings, antiThrashing, budgetTier, gates }
 *
 *   buildAuditPrompt(inputs)
 *     → { system, user, model, max_tokens }
 *
 *   auditCampaign({ ...inputs, callClaude, extractJSON })
 *     → normalized audit object (or short-circuit "keep" when gates fail)
 *
 * The expert pattern: deterministic preprocessing → LLM synthesis →
 * deterministic postprocessing (validation + anti-slop check).
 * ----------------------------------------------------------------------------
 */

const i18n         = require('./i18n-market');
const budget       = require('./budget-calibration');
const checksMeta   = require('./checks-meta');
const checksGoogle = require('./checks-google');
const trendMod     = require('./trend-analysis');
const scoring      = require('./scoring');
const schema       = require('./output-schema');
const antiSlop     = require('./anti-slop');
const sysPrompt    = require('./system-prompt');

/**
 * Phase 1 — Build audit inputs from raw data.
 * All deterministic; runs in <10ms.
 */
function buildAuditInputs({ business, metrics, history = [], decisionHistory = [], plan, platform = 'meta', liveRates = {} }) {
  const marketProfile = i18n.buildMarketProfile(business, { liveRates });
  const dailyBudgetUsd = i18n.toUsd(metrics?.daily_budget, marketProfile.currency, liveRates) ?? metrics?.daily_budget ?? 0;
  const spendUsd = i18n.toUsd(metrics?.spend, marketProfile.currency, liveRates) ?? metrics?.spend ?? 0;
  const budgetTier = budget.tierForDailyBudgetUsd(dailyBudgetUsd);
  const trend = trendMod.buildTrendSummary(history);
  const antiThrashing = trendMod.detectThrashing(decisionHistory);

  // Statistical-significance gate
  const significance = budget.isPauseDataSignificant({
    clicks: metrics?.clicks,
    spend_usd: spendUsd,
    conversions: metrics?.conversions,
    daily_budget_usd: dailyBudgetUsd,
  });

  // Learning-phase gate
  const learning = budget.evaluateLearningPhase({
    conversions_since_edit: metrics?.conversions_since_edit,
    days_since_edit: metrics?.days_since_edit,
    learning_phase_state: metrics?.learning_phase_state,
  });

  // ROAS reliability
  const roasReliability = budget.isRoasReliable({
    conversions: metrics?.conversions,
    daily_budget_usd: dailyBudgetUsd,
  });

  // Run deterministic checks for the platform
  const checkRunner = platform === 'google' ? checksGoogle.runChecks : checksMeta.runChecks;
  const findings = checkRunner({
    metrics: { ...metrics, spend_usd: spendUsd, daily_budget_usd: dailyBudgetUsd, cpm_usd: i18n.toUsd(metrics?.cpm, marketProfile.currency, liveRates), cpc_usd: i18n.toUsd(metrics?.cpc, marketProfile.currency, liveRates) },
    history,
    market: marketProfile,
    decisionHistory,
    plan,
  });

  const auditScore = scoring.computeAuditScore({ findings, metrics, market: marketProfile, trend });

  return {
    marketProfile,
    budgetTier: budget.tierName(budgetTier),
    trend,
    findings,
    antiThrashing,
    gates: {
      significance,
      learning,
      roasReliability,
    },
    auditScore,
  };
}

/**
 * Phase 2 — Build the LLM prompt from inputs.
 */
function buildAuditPrompt(inputs, { business, metrics, decisionHistory, plan }) {
  const system = sysPrompt.buildStableSystemBlock();
  const user = sysPrompt.buildUserMessage({
    business,
    marketProfile: inputs.marketProfile,
    metrics,
    trend: inputs.trend,
    findings: inputs.findings,
    decisionHistory,
    plan,
    antiThrashing: inputs.antiThrashing,
  });
  return {
    system,
    user,
    model: sysPrompt.modelForPlan(plan),
    max_tokens: sysPrompt.maxTokensForPlan(plan),
  };
}

/**
 * Phase 3 — End-to-end audit. Calls Claude via injected callClaude function,
 * validates output, applies post-processing.
 *
 * callClaude signature: ({ system, user, model, max_tokens, extra }) → string
 *   where extra may include { cacheSystem: true } so the system block is
 *   prompt-cached.
 */
async function auditCampaign(opts) {
  const {
    business, metrics, history = [], decisionHistory = [], plan = 'free',
    platform = 'meta', liveRates = {},
    callClaude, extractJSON, logger,
  } = opts || {};

  if (typeof callClaude !== 'function') throw new Error('auditCampaign: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('auditCampaign: extractJSON required');

  const inputs = buildAuditInputs({ business, metrics, history, decisionHistory, plan, platform, liveRates });

  // ─── Hard short-circuits (don't even spend an LLM call) ────────────────
  // These are deterministic decisions — saves cost, prevents dumb LLM moves.

  if (!inputs.gates.significance.significant) {
    return _shortCircuit({
      decision: 'keep',
      reason: `Insufficient data for action: ${inputs.gates.significance.reason}`,
      inputs,
      reason_key: 'insufficient_data',
    });
  }
  if (inputs.gates.learning.in_learning && _wouldRecommendPause(inputs)) {
    return _shortCircuit({
      decision: 'keep',
      reason: 'In learning phase — protecting from premature edits',
      inputs,
      reason_key: 'learning_phase',
    });
  }

  // Critical compliance findings → immediate pause regardless of plan
  const policyHit = inputs.findings.find(f => f.category === 'compliance' && f.severity === 'critical');
  if (policyHit) {
    return _shortCircuit({
      decision: 'pause',
      reason: policyHit.title,
      inputs,
      reason_key: 'compliance_critical',
    });
  }

  // ─── LLM synthesis ─────────────────────────────────────────────────────
  const prompt = buildAuditPrompt(inputs, { business, metrics, decisionHistory, plan });

  let raw;
  try {
    raw = await callClaude({
      system: prompt.system,
      user: prompt.user,
      model: prompt.model,
      max_tokens: prompt.max_tokens,
      extra: {
        cacheSystem: true,           // prompt-cache the 12k-char system block
        temperature: 0.2,            // low randomness for decisions
      },
    });
  } catch (e) {
    logger?.error('ad-optimizer.auditCampaign', null, 'Claude call failed', e);
    return _shortCircuit({
      decision: 'keep',
      reason: 'Audit AI unavailable — keeping current state',
      inputs,
      reason_key: 'llm_error',
    });
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  if (!parsed) {
    return _shortCircuit({
      decision: 'keep',
      reason: 'Audit response unparseable — keeping current state',
      inputs,
      reason_key: 'parse_error',
    });
  }

  // ─── Post-process: validate + anti-slop ────────────────────────────────
  const v = schema.validateAuditOutput(parsed);
  if (!v.valid) {
    logger?.warn?.('ad-optimizer', null, 'invalid LLM output', v.errors);
    return _shortCircuit({
      decision: 'keep',
      reason: 'Audit response invalid — keeping current state',
      inputs,
      reason_key: 'schema_error',
      schema_errors: v.errors,
    });
  }

  const slopViolations = antiSlop.validateAuditResponse(v.normalized);

  // Override LLM's decision with anti-thrashing logic if needed
  const finalDecision = _applyAntiThrashing(v.normalized.decision, inputs);

  return {
    ...v.normalized,
    decision: finalDecision.decision,
    decision_reason: finalDecision.changed ? `${v.normalized.decision_reason} (anti-thrash: ${finalDecision.reason})` : v.normalized.decision_reason,
    audit_score: inputs.auditScore.score,
    score_breakdown: inputs.auditScore.dimensions,
    market_tier: inputs.marketProfile.tier_name,
    budget_tier: inputs.budgetTier,
    deterministic_findings: inputs.findings,
    short_circuited: false,
    slop_violations: slopViolations,
    gates: {
      significance: inputs.gates.significance.significant,
      in_learning: inputs.gates.learning.in_learning,
      roas_reliable: inputs.gates.roasReliability.reliable,
    },
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

function _shortCircuit({ decision, reason, inputs, reason_key, schema_errors }) {
  return {
    decision,
    decision_reason: reason,
    new_daily_budget: null,
    audit_score: inputs?.auditScore?.score ?? 0,
    score_breakdown: inputs?.auditScore?.dimensions ?? null,
    critical_issues: [],
    warnings: [],
    opportunities: [],
    trend: inputs?.trend ?? null,
    citations: [],
    market_tier: inputs?.marketProfile?.tier_name ?? null,
    budget_tier: inputs?.budgetTier ?? null,
    deterministic_findings: inputs?.findings ?? [],
    short_circuited: true,
    short_circuit_reason: reason_key,
    schema_errors: schema_errors || null,
    gates: {
      significance: inputs?.gates?.significance?.significant ?? null,
      in_learning: inputs?.gates?.learning?.in_learning ?? null,
      roas_reliable: inputs?.gates?.roasReliability?.reliable ?? null,
    },
  };
}

function _wouldRecommendPause(inputs) {
  // If any critical-severity finding exists in budget/conversion category,
  // a pause would be expected. Used to gate learning-phase protection.
  return inputs.findings.some(f =>
    (f.category === 'budget' || f.category === 'conversion') && f.severity === 'critical'
  );
}

function _applyAntiThrashing(llmDecision, inputs) {
  const t = inputs.antiThrashing;
  if (!t || !t.thrashing) return { decision: llmDecision, changed: false };
  // Recent pause within 48h + LLM says pause again → switch to optimize
  if (t.pattern === 'recent_pause_within_48h' && llmDecision === 'pause') {
    return { decision: 'optimize', changed: true, reason: 'paused 48h ago, no re-pause' };
  }
  // pause_unpause_pause pattern → recommend optimize
  if (t.pattern === 'pause_unpause_pause' && llmDecision === 'pause') {
    return { decision: 'optimize', changed: true, reason: 'oscillation detected — root-cause is creative/audience' };
  }
  return { decision: llmDecision, changed: false };
}

/**
 * Audit existing ad copy for psychology principles. Used by callers that
 * have ad creative text + want to know which principles are present/missing
 * BEFORE making the scale/pause/keep decision (creative-quality dimension).
 *
 * Lazy-loaded to avoid circular import paths.
 */
async function auditAdCopyPsychology({ adCopy, business, plan, callClaude, extractJSON, logger }) {
  if (!adCopy || typeof adCopy !== 'string' || adCopy.length < 10) {
    return { skipped: true, reason: 'insufficient_copy' };
  }
  const psy = require('../marketing-psychology');
  return psy.audit({
    text: adCopy,
    business,
    funnelStage: 'consideration',
    plan: plan || 'free',
    callClaude, extractJSON, logger,
  });
}

module.exports = {
  buildAuditInputs,
  buildAuditPrompt,
  auditCampaign,
  auditAdCopyPsychology,
  // Re-exports for tests + callers
  i18n,
  budget,
  scoring,
  schema,
  antiSlop,
  trend: trendMod,
  checksMeta,
  checksGoogle,
};
