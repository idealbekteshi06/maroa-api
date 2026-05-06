'use strict';

/**
 * services/prompts/ai-seo/output-schema.js
 * ----------------------------------------------------------------------------
 * Validators for the two AI-SEO LLM output shapes (audit + generate).
 * ----------------------------------------------------------------------------
 */

const VALID_DIMENSIONS = [
  'schema_markup', 'extractable_answers', 'entity_associations',
  'llms_txt_presence', 'citation_worthiness', 'structured_tldrs',
  'anchor_consistency', 'i18n_hreflang',
];
const VALID_READINESS = ['minimal', 'partial', 'strong'];
const VALID_POTENTIAL = ['low', 'medium', 'high'];

function validateAuditOutput(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };

  const score = Number(raw.audit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    errors.push(`audit_score must be 0-100; got ${raw.audit_score}`);
  }
  if (raw.dimension_scores != null && typeof raw.dimension_scores !== 'object') {
    errors.push('dimension_scores must be object');
  }
  if (raw.dimension_scores) {
    for (const k of Object.keys(raw.dimension_scores)) {
      if (!VALID_DIMENSIONS.includes(k)) errors.push(`unknown dimension: ${k}`);
      const v = Number(raw.dimension_scores[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) errors.push(`dimension_scores.${k} out of range`);
    }
  }
  for (const f of ['critical_gaps', 'warnings', 'opportunities']) {
    if (raw[f] != null && !Array.isArray(raw[f])) errors.push(`${f} must be array`);
  }
  if (raw.ai_search_readiness && !VALID_READINESS.includes(raw.ai_search_readiness)) {
    errors.push(`ai_search_readiness invalid: ${raw.ai_search_readiness}`);
  }
  if (raw.estimated_citation_potential && !VALID_POTENTIAL.includes(raw.estimated_citation_potential)) {
    errors.push(`estimated_citation_potential invalid: ${raw.estimated_citation_potential}`);
  }
  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    normalized: {
      audit_score: Math.round(score),
      dimension_scores: raw.dimension_scores || {},
      critical_gaps: Array.isArray(raw.critical_gaps) ? raw.critical_gaps : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      opportunities: Array.isArray(raw.opportunities) ? raw.opportunities : [],
      ai_search_readiness: raw.ai_search_readiness || 'minimal',
      estimated_citation_potential: raw.estimated_citation_potential || 'low',
      primary_language: raw.primary_language || null,
      country: raw.country || null,
      citations: Array.isArray(raw.citations) ? raw.citations : [],
    },
  };
}

function validateGenerateOutput(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };

  if (raw.llms_txt != null && typeof raw.llms_txt !== 'string') errors.push('llms_txt must be string');
  if (raw.llms_full_txt != null && typeof raw.llms_full_txt !== 'string') errors.push('llms_full_txt must be string');
  if (raw.schema_blocks != null && !Array.isArray(raw.schema_blocks)) errors.push('schema_blocks must be array');
  if (raw.page_rewrites != null && !Array.isArray(raw.page_rewrites)) errors.push('page_rewrites must be array');
  if (raw.internal_link_suggestions != null && !Array.isArray(raw.internal_link_suggestions)) errors.push('internal_link_suggestions must be array');

  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    normalized: {
      llms_txt: raw.llms_txt || '',
      llms_full_txt: raw.llms_full_txt || null,
      schema_blocks: Array.isArray(raw.schema_blocks) ? raw.schema_blocks : [],
      page_rewrites: Array.isArray(raw.page_rewrites) ? raw.page_rewrites : [],
      internal_link_suggestions: Array.isArray(raw.internal_link_suggestions) ? raw.internal_link_suggestions : [],
    },
  };
}

module.exports = {
  VALID_DIMENSIONS,
  VALID_READINESS,
  VALID_POTENTIAL,
  validateAuditOutput,
  validateGenerateOutput,
};
