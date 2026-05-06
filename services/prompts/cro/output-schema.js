'use strict';

/**
 * services/prompts/cro/output-schema.js
 * ----------------------------------------------------------------------------
 * Validators for CRO audit + rewrite outputs.
 * ----------------------------------------------------------------------------
 */

const VALID_DIMENSIONS = ['above_the_fold', 'value_prop', 'primary_cta', 'social_proof', 'trust', 'friction', 'mobile'];
const VALID_BANDS = ['low', 'average', 'strong'];
const VALID_LIFTS = ['low', 'medium', 'high'];

function validateAudit(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };

  const score = Number(raw.audit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) errors.push(`audit_score 0-100, got ${raw.audit_score}`);

  if (raw.dimension_scores) {
    if (typeof raw.dimension_scores !== 'object') errors.push('dimension_scores must be object');
    else {
      for (const k of Object.keys(raw.dimension_scores)) {
        if (!VALID_DIMENSIONS.includes(k)) errors.push(`unknown dimension: ${k}`);
      }
    }
  }
  for (const f of ['critical_issues', 'warnings', 'opportunities']) {
    if (raw[f] != null && !Array.isArray(raw[f])) errors.push(`${f} must be array`);
  }
  if (raw.current_estimated_conv_rate_band && !VALID_BANDS.includes(raw.current_estimated_conv_rate_band)) {
    errors.push(`current_estimated_conv_rate_band invalid`);
  }
  if (raw.expected_lift_band && !VALID_LIFTS.includes(raw.expected_lift_band)) {
    errors.push(`expected_lift_band invalid`);
  }

  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    normalized: {
      audit_score: Math.round(score),
      dimension_scores: raw.dimension_scores || {},
      critical_issues: Array.isArray(raw.critical_issues) ? raw.critical_issues : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      opportunities: Array.isArray(raw.opportunities) ? raw.opportunities : [],
      primary_language: raw.primary_language || null,
      country: raw.country || null,
      current_estimated_conv_rate_band: raw.current_estimated_conv_rate_band || 'average',
      expected_lift_band: raw.expected_lift_band || 'low',
      citations: Array.isArray(raw.citations) ? raw.citations : [],
    },
  };
}

function validateRewrite(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };
  for (const f of ['hero_headline_variants', 'hero_subhead_variants', 'primary_cta_variants', 'value_prop_bullets']) {
    if (raw[f] != null && !Array.isArray(raw[f])) errors.push(`${f} must be array`);
  }
  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    normalized: {
      hero_headline_variants: Array.isArray(raw.hero_headline_variants) ? raw.hero_headline_variants : [],
      hero_subhead_variants: Array.isArray(raw.hero_subhead_variants) ? raw.hero_subhead_variants : [],
      primary_cta_variants: Array.isArray(raw.primary_cta_variants) ? raw.primary_cta_variants : [],
      value_prop_bullets: Array.isArray(raw.value_prop_bullets) ? raw.value_prop_bullets : [],
      social_proof_template: raw.social_proof_template || null,
      form_simplification: raw.form_simplification || null,
    },
  };
}

module.exports = { VALID_DIMENSIONS, validateAudit, validateRewrite };
