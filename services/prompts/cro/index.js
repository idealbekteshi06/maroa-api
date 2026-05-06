'use strict';

/**
 * services/prompts/cro/index.js
 * ----------------------------------------------------------------------------
 * Public entry — auditPage + rewritePage. Same expert pattern as ad-optimizer
 * + ai-seo: deterministic preprocessing → LLM synthesis → schema validation.
 * ----------------------------------------------------------------------------
 */

const i18nCro    = require('./i18n-cro');
const checksPage = require('./checks-page');
const scoring    = require('./scoring');
const schema     = require('./output-schema');
const sysPrompt  = require('./system-prompt');

/**
 * Audit a page end-to-end.
 */
async function auditPage(opts) {
  const { business, html, text, plan = 'free', callClaude, extractJSON, logger } = opts || {};
  if (typeof callClaude !== 'function') throw new Error('auditPage: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('auditPage: extractJSON required');

  const marketProfile = i18nCro.buildCroMarketProfile(business);
  const findings = checksPage.runChecks({ html, text, business, marketProfile, plan });
  const deterministicScore = scoring.computeScore({ findings });

  // Honest-scoring guard
  if (!html && !text) {
    return _shortCircuit({
      score: 25, reason: 'No page content provided', findings, marketProfile, deterministicScore,
    });
  }

  const system = sysPrompt.buildAuditSystemBlock();
  const user = sysPrompt.buildAuditUserMessage({ business, marketProfile, html, text, findings, deterministicScore, plan });

  let raw;
  try {
    raw = await callClaude({
      system, user,
      model: sysPrompt.modelForPlan(plan),
      max_tokens: sysPrompt.maxTokensForPlan(plan, 'audit'),
      extra: { cacheSystem: true, temperature: 0.2 },
    });
  } catch (e) {
    logger?.error?.('cro.auditPage', null, 'Claude call failed', e);
    return _shortCircuit({ score: deterministicScore.score, reason: 'Audit AI unavailable — using deterministic baseline', findings, marketProfile, deterministicScore });
  }

  let parsed; try { parsed = extractJSON(raw); } catch { parsed = null; }
  const v = parsed ? schema.validateAudit(parsed) : { valid: false, errors: ['parse_error'] };
  if (!v.valid) {
    logger?.warn?.('cro', null, 'invalid LLM output', v.errors);
    return _shortCircuit({ score: deterministicScore.score, reason: 'Audit response invalid — using baseline', findings, marketProfile, deterministicScore, schema_errors: v.errors });
  }

  const criticalCount = (v.normalized.critical_issues || []).length;
  const lift = scoring.expectedLiftBand({ score: v.normalized.audit_score, criticalCount });

  return {
    ...v.normalized,
    audit_score: v.normalized.audit_score || deterministicScore.score,
    dimension_scores: { ...deterministicScore.dimensions, ...(v.normalized.dimension_scores || {}) },
    expected_lift_band: v.normalized.expected_lift_band || lift,
    current_estimated_conv_rate_band: v.normalized.current_estimated_conv_rate_band || scoring.bandForScore(v.normalized.audit_score),
    deterministic_findings: findings,
    market_country: marketProfile.country,
    short_circuited: false,
  };
}

/**
 * Rewrite hero / CTA / value-prop block.
 */
async function rewritePage(opts) {
  const { business, currentHero, plan = 'free', callClaude, extractJSON, logger } = opts || {};
  if (typeof callClaude !== 'function') throw new Error('rewritePage: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('rewritePage: extractJSON required');

  const marketProfile = i18nCro.buildCroMarketProfile(business);

  // Free tier: deterministic-only suggestions (templates, no LLM call)
  if (String(plan).toLowerCase() === 'free') {
    return _deterministicRewrite(business, marketProfile);
  }

  const system = sysPrompt.buildRewriteSystemBlock();
  const user = sysPrompt.buildRewriteUserMessage({ business, marketProfile, currentHero, plan });

  let raw;
  try {
    raw = await callClaude({
      system, user,
      model: sysPrompt.modelForPlan(plan),
      max_tokens: sysPrompt.maxTokensForPlan(plan, 'rewrite'),
      extra: { cacheSystem: true, temperature: 0.5 },
    });
  } catch (e) {
    logger?.error?.('cro.rewritePage', null, 'Claude call failed', e);
    return _deterministicRewrite(business, marketProfile);
  }

  let parsed; try { parsed = extractJSON(raw); } catch { parsed = null; }
  const v = parsed ? schema.validateRewrite(parsed) : { valid: false, errors: ['parse_error'] };
  if (!v.valid) {
    return _deterministicRewrite(business, marketProfile);
  }

  // Score the LLM CTAs to make sure they're not weak
  const ctas = (v.normalized.primary_cta_variants || []).map(c => ({
    ...c,
    cta_score: i18nCro.scoreCta(c.text, marketProfile),
  }));

  return {
    ...v.normalized,
    primary_cta_variants: ctas,
    market_country: marketProfile.country,
    llm_used: true,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

function _deterministicRewrite(business, marketProfile) {
  // Generic but locale-correct fallback when free-tier or LLM fails.
  const lang = marketProfile?.primary_language || 'en';
  const verbs = marketProfile?.cta_imperative_verbs || [];
  const ctaVerb = verbs[0] || (lang === 'en' ? 'Get' : '');
  const businessName = business?.business_name || 'us';
  return {
    hero_headline_variants: [],
    hero_subhead_variants: [],
    primary_cta_variants: ctaVerb ? [{ text: `${ctaVerb} ${businessName}`, style: 'action_imperative', cta_score: 5 }] : [],
    value_prop_bullets: [],
    social_proof_template: null,
    form_simplification: null,
    market_country: marketProfile?.country,
    llm_used: false,
    deterministic_only: true,
  };
}

function _shortCircuit({ score, reason, findings, marketProfile, deterministicScore, schema_errors }) {
  return {
    audit_score: score,
    dimension_scores: deterministicScore?.dimensions || {},
    critical_issues: (findings || []).filter(f => f.severity === 'critical').map(f => ({
      id: f.check_id, severity: f.severity, fix: f.fix, time_to_fix_minutes: f.time_to_fix_minutes,
    })),
    warnings: (findings || []).filter(f => f.severity === 'warning').map(f => ({
      id: f.check_id, severity: f.severity, fix: f.fix, time_to_fix_minutes: f.time_to_fix_minutes,
    })),
    opportunities: [],
    primary_language: marketProfile?.primary_language || null,
    country: marketProfile?.country || null,
    current_estimated_conv_rate_band: scoring.bandForScore(score),
    expected_lift_band: 'low',
    citations: [],
    deterministic_findings: findings,
    market_country: marketProfile?.country || null,
    short_circuited: true,
    short_circuit_reason: reason,
    schema_errors: schema_errors || null,
  };
}

module.exports = {
  auditPage,
  rewritePage,
  i18nCro,
  checksPage,
  scoring,
  schema,
};
