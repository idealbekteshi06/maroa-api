'use strict';

/**
 * services/prompts/ai-seo/index.js
 * ----------------------------------------------------------------------------
 * Public entry point. Two modes:
 *   - auditSite()      → score + gaps + opportunities
 *   - generateArtifacts() → llms.txt, schemas, page rewrites
 *
 * Same expert pattern as ad-optimizer:
 *   deterministic preprocessing → LLM synthesis → schema validation.
 * ----------------------------------------------------------------------------
 */

const i18nSeo       = require('./i18n-seo');
const checks        = require('./citability-checks');
const llmsTxt       = require('./llms-txt-generator');
const schemaBuilder = require('./schema-builder');
const rewriter      = require('./content-rewriter');
const entity        = require('./entity-extractor');
const schema        = require('./output-schema');
const sysPrompt     = require('./system-prompt');

/**
 * Build the deterministic baseline (always runs, fast, no LLM call).
 */
function buildAuditBaseline({ business, html, text, llms_txt_present, llms_full_txt_present, plan = 'free' }) {
  const marketProfile = i18nSeo.buildSeoMarketProfile(business);
  const findings = checks.runChecks({
    html, text, business, marketProfile, llms_txt_present, llms_full_txt_present, plan,
  });

  // Deterministic dimension scores from findings
  const dims = {
    schema_markup: 100,
    extractable_answers: 100,
    entity_associations: 100,
    llms_txt_presence: 100,
    citation_worthiness: 100,
    structured_tldrs: 100,
    anchor_consistency: 100,
    i18n_hreflang: 100,
  };
  const sevPenalty = { critical: 30, warning: 12, info: 4 };
  for (const f of findings) {
    if (dims[f.dimension] != null) {
      dims[f.dimension] = Math.max(0, dims[f.dimension] - (sevPenalty[f.severity] || 5));
    }
  }
  // Extractability boost from heuristic
  const extScore = rewriter.scoreExtractability(text || '');
  dims.citation_worthiness = Math.round((dims.citation_worthiness + extScore) / 2);

  // Weighted overall (equal weight v1)
  const overall = Math.round(
    Object.values(dims).reduce((a, b) => a + b, 0) / Object.keys(dims).length
  );

  return { marketProfile, findings, dims, overall };
}

/**
 * Phase 2: end-to-end audit with LLM synthesis on top of baseline.
 */
async function auditSite(opts) {
  const {
    business, html, text, llms_txt_present, llms_full_txt_present,
    plan = 'free', callClaude, extractJSON, logger,
  } = opts || {};
  if (typeof callClaude !== 'function') throw new Error('auditSite: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('auditSite: extractJSON required');

  const baseline = buildAuditBaseline({ business, html, text, llms_txt_present, llms_full_txt_present, plan });

  // Honest-scoring guard: if input is too thin, short-circuit
  if (!text && !html) {
    return _shortCircuit({
      audit_score: 25,
      ai_search_readiness: 'minimal',
      reason: 'No page content provided — cannot meaningfully audit AI-search readiness',
      baseline,
    });
  }

  // LLM synthesis
  const system = sysPrompt.buildAuditSystemBlock();
  const user = sysPrompt.buildAuditUserMessage({
    business,
    marketProfile: baseline.marketProfile,
    html, text,
    findings: baseline.findings,
    llms_txt_present, llms_full_txt_present,
    plan,
  });
  let raw;
  try {
    raw = await callClaude({
      system, user,
      model: sysPrompt.modelForPlan(plan),
      max_tokens: sysPrompt.maxTokensForPlan(plan, 'audit'),
      extra: { cacheSystem: true, temperature: 0.2 },
    });
  } catch (e) {
    logger?.error?.('ai-seo.auditSite', null, 'Claude call failed', e);
    return _shortCircuit({
      audit_score: baseline.overall,
      ai_search_readiness: 'minimal',
      reason: 'Audit AI unavailable — using deterministic baseline only',
      baseline,
    });
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  const v = parsed ? schema.validateAuditOutput(parsed) : { valid: false, errors: ['parse_error'] };
  if (!v.valid) {
    logger?.warn?.('ai-seo', null, 'invalid LLM output', v.errors);
    return _shortCircuit({
      audit_score: baseline.overall,
      ai_search_readiness: baseline.overall >= 60 ? 'partial' : 'minimal',
      reason: 'Audit response invalid — using deterministic baseline',
      baseline,
      schema_errors: v.errors,
    });
  }

  return {
    ...v.normalized,
    audit_score: v.normalized.audit_score || baseline.overall,
    dimension_scores: { ...baseline.dims, ...(v.normalized.dimension_scores || {}) },
    deterministic_findings: baseline.findings,
    market_country: baseline.marketProfile.country,
    market_tier_ai_penetration: baseline.marketProfile.ai_search_penetration,
    short_circuited: false,
  };
}

/**
 * Generate llms.txt + schema + page rewrites for a business.
 * This is the PRODUCT side — actual artifacts the customer ships.
 */
async function generateArtifacts(opts) {
  const {
    business, pages = [],
    plan = 'free', callClaude, extractJSON, logger,
  } = opts || {};
  if (typeof callClaude !== 'function') throw new Error('generateArtifacts: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('generateArtifacts: extractJSON required');

  // Free tier: deterministic only (no LLM call → cheap)
  if (String(plan).toLowerCase() === 'free') {
    return _deterministicOnly(business, pages);
  }

  const marketProfile = i18nSeo.buildSeoMarketProfile(business);
  const baseLlmsTxt = llmsTxt.buildLlmsTxt({ business, pages, primaryLanguage: marketProfile.primary_language });
  const suggestedQuestions = rewriter.suggestStandardQuestions({ business });

  const system = sysPrompt.buildGenerateSystemBlock();
  const user = sysPrompt.buildGenerateUserMessage({
    business, marketProfile, pages, baseLlmsTxt, suggestedQuestions,
  });
  let raw;
  try {
    raw = await callClaude({
      system, user,
      model: sysPrompt.modelForPlan(plan),
      max_tokens: sysPrompt.maxTokensForPlan(plan, 'generate'),
      extra: { cacheSystem: true, temperature: 0.4 },
    });
  } catch (e) {
    logger?.error?.('ai-seo.generateArtifacts', null, 'Claude call failed', e);
    return _deterministicOnly(business, pages, marketProfile);
  }

  let parsed;
  try { parsed = extractJSON(raw); } catch { parsed = null; }
  const v = parsed ? schema.validateGenerateOutput(parsed) : { valid: false, errors: ['parse_error'] };

  // ALWAYS include the deterministic baseline schemas — never fully trust LLM
  const baseSchemas = [
    schemaBuilder.buildOrganization({ business, sameAs: entity.buildSameAs({ business }) }),
    schemaBuilder.buildWebSite({ business }),
  ];
  if (business?.operation_model === 'location_based' || business?.operation_model === 'hybrid') {
    baseSchemas.push(schemaBuilder.buildLocalBusiness({ business, marketProfile }));
  }

  if (!v.valid) {
    return {
      llms_txt: baseLlmsTxt,
      llms_full_txt: null,
      schema_blocks: baseSchemas.map(s => ({ type: s['@type'], page_url: business?.website, jsonld: s })),
      page_rewrites: [],
      internal_link_suggestions: [],
      llm_used: false,
      schema_errors: v.errors,
    };
  }

  // Merge LLM output with deterministic schemas (LLM can't be trusted alone)
  const llmSchemaTypes = (v.normalized.schema_blocks || []).map(s => s.type);
  const merged = [
    ...v.normalized.schema_blocks,
    ...baseSchemas
      .filter(s => !llmSchemaTypes.includes(s['@type']))
      .map(s => ({ type: s['@type'], page_url: business?.website, jsonld: s })),
  ];

  return {
    llms_txt: v.normalized.llms_txt || baseLlmsTxt,
    llms_full_txt: v.normalized.llms_full_txt,
    schema_blocks: merged,
    page_rewrites: v.normalized.page_rewrites,
    internal_link_suggestions: v.normalized.internal_link_suggestions,
    llm_used: true,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

function _deterministicOnly(business, pages, marketProfile) {
  const profile = marketProfile || i18nSeo.buildSeoMarketProfile(business);
  const baseSchemas = [
    schemaBuilder.buildOrganization({ business, sameAs: entity.buildSameAs({ business }) }),
    schemaBuilder.buildWebSite({ business }),
  ];
  if (business?.operation_model === 'location_based' || business?.operation_model === 'hybrid') {
    baseSchemas.push(schemaBuilder.buildLocalBusiness({ business, marketProfile: profile }));
  }
  return {
    llms_txt: llmsTxt.buildLlmsTxt({ business, pages, primaryLanguage: profile.primary_language }),
    llms_full_txt: null,
    schema_blocks: baseSchemas.map(s => ({ type: s['@type'], page_url: business?.website, jsonld: s })),
    page_rewrites: [],
    internal_link_suggestions: [],
    llm_used: false,
  };
}

function _shortCircuit({ audit_score, ai_search_readiness, reason, baseline, schema_errors }) {
  return {
    audit_score,
    dimension_scores: baseline?.dims || {},
    critical_gaps: (baseline?.findings || []).filter(f => f.severity === 'critical').map(f => ({
      id: f.check_id, severity: f.severity, fix: f.fix,
    })),
    warnings: (baseline?.findings || []).filter(f => f.severity === 'warning').map(f => ({
      id: f.check_id, severity: f.severity, fix: f.fix,
    })),
    opportunities: [],
    ai_search_readiness,
    estimated_citation_potential: 'low',
    primary_language: baseline?.marketProfile?.primary_language || null,
    country: baseline?.marketProfile?.country || null,
    citations: [],
    deterministic_findings: baseline?.findings || [],
    market_country: baseline?.marketProfile?.country || null,
    short_circuited: true,
    short_circuit_reason: reason,
    schema_errors: schema_errors || null,
  };
}

module.exports = {
  buildAuditBaseline,
  auditSite,
  generateArtifacts,
  // re-exports
  i18nSeo,
  checks,
  llmsTxt,
  schemaBuilder,
  rewriter,
  entity,
  schema,
};
