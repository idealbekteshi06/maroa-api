'use strict';

/**
 * services/prompts/ad-optimizer/output-schema.js
 * ----------------------------------------------------------------------------
 * JSON-schema-equivalent validator for audit responses. Pure JS, no
 * dependency. The LLM is instructed to return this shape; we validate before
 * accepting.
 *
 * Returns { valid: boolean, errors: string[], normalized?: object }.
 * If valid, the `normalized` object has all fields canonicalized to safe
 * defaults (no nulls becoming undefined, arrays always present, etc.).
 * ----------------------------------------------------------------------------
 */

const VALID_DECISIONS = ['scale', 'pause', 'keep', 'optimize', 'refresh_creative'];
const VALID_SEVERITIES = ['critical', 'warning', 'info'];
const VALID_TRENDS_ROAS = ['improving', 'stable', 'declining'];
const VALID_TRENDS_FREQ = ['stable', 'climbing', 'escalating'];
const VALID_TRENDS_VEL  = ['under', 'on_pace', 'over'];

function validateAuditOutput(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['response is not an object'] };
  }

  // ─── decision ─────────────────────────────────────────────────────────
  if (!VALID_DECISIONS.includes(raw.decision)) {
    errors.push(`decision must be one of ${VALID_DECISIONS.join('|')}; got ${raw.decision}`);
  }

  // ─── decision_reason ──────────────────────────────────────────────────
  if (typeof raw.decision_reason !== 'string' || raw.decision_reason.trim().length === 0) {
    errors.push('decision_reason required (string)');
  } else if (raw.decision_reason.length > 280) {
    errors.push(`decision_reason too long (${raw.decision_reason.length} > 280 chars)`);
  }

  // ─── new_daily_budget ─────────────────────────────────────────────────
  if (raw.new_daily_budget != null && !Number.isFinite(Number(raw.new_daily_budget))) {
    errors.push('new_daily_budget must be number or null');
  }
  if (['scale', 'optimize'].includes(raw.decision) && raw.new_daily_budget == null) {
    // Not strictly required — engine can fall back to safeBudgetChange.
  }
  if (raw.decision === 'pause' && raw.new_daily_budget != null) {
    errors.push('new_daily_budget should be null when decision=pause');
  }

  // ─── audit_score ──────────────────────────────────────────────────────
  const score = Number(raw.audit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    errors.push(`audit_score must be 0-100; got ${raw.audit_score}`);
  }

  // ─── critical_issues / warnings / opportunities ───────────────────────
  for (const key of ['critical_issues', 'warnings', 'opportunities']) {
    if (raw[key] != null && !Array.isArray(raw[key])) {
      errors.push(`${key} must be array`);
    }
  }
  for (const issue of raw.critical_issues || []) {
    if (!issue.check_id) errors.push(`critical_issues[].check_id required`);
    if (issue.severity && !VALID_SEVERITIES.includes(issue.severity)) {
      errors.push(`critical_issues[].severity invalid: ${issue.severity}`);
    }
  }

  // ─── trend ────────────────────────────────────────────────────────────
  if (raw.trend && typeof raw.trend === 'object') {
    if (raw.trend.roas_7d && !VALID_TRENDS_ROAS.includes(raw.trend.roas_7d)) {
      errors.push(`trend.roas_7d invalid: ${raw.trend.roas_7d}`);
    }
    if (raw.trend.frequency_trajectory && !VALID_TRENDS_FREQ.includes(raw.trend.frequency_trajectory)) {
      errors.push(`trend.frequency_trajectory invalid: ${raw.trend.frequency_trajectory}`);
    }
    if (raw.trend.spend_velocity && !VALID_TRENDS_VEL.includes(raw.trend.spend_velocity)) {
      errors.push(`trend.spend_velocity invalid: ${raw.trend.spend_velocity}`);
    }
  }

  // ─── citations ────────────────────────────────────────────────────────
  if (raw.citations != null && !Array.isArray(raw.citations)) {
    errors.push('citations must be array');
  }

  if (errors.length) return { valid: false, errors };

  // Normalize to safe defaults
  const normalized = {
    decision: raw.decision,
    decision_reason: raw.decision_reason.trim(),
    new_daily_budget: raw.new_daily_budget != null ? Number(raw.new_daily_budget) : null,
    audit_score: Math.round(score),
    critical_issues: Array.isArray(raw.critical_issues) ? raw.critical_issues : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    opportunities: Array.isArray(raw.opportunities) ? raw.opportunities : [],
    trend: raw.trend && typeof raw.trend === 'object' ? {
      roas_7d: raw.trend.roas_7d || null,
      frequency_trajectory: raw.trend.frequency_trajectory || null,
      spend_velocity: raw.trend.spend_velocity || null,
      creative_fatigue_eta_days: Number.isFinite(Number(raw.trend.creative_fatigue_eta_days))
        ? Number(raw.trend.creative_fatigue_eta_days) : null,
    } : null,
    citations: Array.isArray(raw.citations) ? raw.citations : [],
  };

  return { valid: true, errors: [], normalized };
}

module.exports = {
  VALID_DECISIONS,
  VALID_SEVERITIES,
  validateAuditOutput,
};
