'use strict';

/**
 * lib/structuredOutputs.js — JSON-schema output formats for decision-critical
 * Claude calls (Anthropic structured outputs, GA).
 *
 * Passed as `extra.outputFormat` to callClaude → lands in
 * `output_config.format`. The API then guarantees schema-valid JSON, which
 * removes the malformed-JSON failure class ("forgot a closing brace") from
 * ad decisions, lead scoring, quality gates, and compliance rewrites.
 * Existing extractJSON() call sites keep working — the response text is
 * simply always parseable now; repair loops stay as belt-and-suspenders.
 *
 * Schema rules (API-enforced): every object needs additionalProperties:false;
 * numeric min/max and string length constraints are NOT supported — keep
 * range enforcement in app code (e.g. budget clamps in ad-optimizer/engine).
 */

function fmt(schema) {
  return { type: 'json_schema', schema };
}

/** Ad-optimizer campaign audit decision (services/prompts/ad-optimizer). */
const adOptimizerAudit = fmt({
  type: 'object',
  additionalProperties: false,
  required: [
    'decision',
    'decision_reason',
    'audit_score',
    'new_daily_budget',
    'score_breakdown',
    'critical_issues',
    'warnings',
    'opportunities',
    'trend',
    'citations',
  ],
  properties: {
    decision: { type: 'string', enum: ['scale', 'pause', 'keep', 'optimize', 'refresh_creative'] },
    decision_reason: { type: 'string' },
    audit_score: { type: 'number' },
    new_daily_budget: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    score_breakdown: {
      type: 'object',
      additionalProperties: false,
      required: ['targeting', 'creative', 'budget_pacing', 'funnel'],
      properties: {
        targeting: { type: 'number' },
        creative: { type: 'number' },
        budget_pacing: { type: 'number' },
        funnel: { type: 'number' },
      },
    },
    critical_issues: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    opportunities: { type: 'array', items: { type: 'string' } },
    trend: { type: 'string', enum: ['improving', 'stable', 'declining'] },
    citations: { type: 'array', items: { type: 'string' } },
  },
});

/** WF2 lead-response draft (subject/body + quality estimates). */
const leadResponse = fmt({
  type: 'object',
  additionalProperties: false,
  required: [
    'subject',
    'body',
    'personalizationScore',
    'qualityChecks',
    'predictedResponseRate',
    'psychologyLevers',
    'frameworkJustification',
  ],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    personalizationScore: { type: 'number' },
    qualityChecks: {
      // Mirrors workflow_2_lead_scoring's declared OUTPUT FORMAT exactly.
      type: 'object',
      additionalProperties: false,
      required: ['personalization', 'length', 'ctaClarity', 'toneMatch', 'noTypos'],
      properties: {
        personalization: { type: 'number' },
        length: { type: 'boolean' },
        ctaClarity: { type: 'boolean' },
        toneMatch: { type: 'boolean' },
        noTypos: { type: 'boolean' },
      },
    },
    predictedResponseRate: {
      type: 'object',
      additionalProperties: false,
      required: ['low', 'high'],
      properties: { low: { type: 'number' }, high: { type: 'number' } },
    },
    psychologyLevers: { type: 'array', items: { type: 'string' } },
    frameworkJustification: { type: 'string' },
  },
});

/** Quality-gate LLM advisor verdict. */
const qualityGateAdvisor = fmt({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'issues', 'feedback'],
  properties: {
    decision: { type: 'string', enum: ['ship', 'retry', 'reject'] },
    issues: { type: 'array', items: { type: 'string' } },
    feedback: { type: 'string' },
  },
});

/** Compliance copy rewrite (lib/complianceEngine — matches its declared JSON contract). */
const complianceRewrite = fmt({
  type: 'object',
  additionalProperties: false,
  required: ['rewrite', 'preserved_intent'],
  properties: {
    rewrite: { type: 'string' },
    preserved_intent: { type: 'string' },
  },
});

/** Weekly scorecard narrative commentary (matches prompts/weekly-scorecard OUTPUT SCHEMA). */
const scorecardCommentary = fmt({
  type: 'object',
  additionalProperties: false,
  required: ['trend_interpretation', 'top_actions', 'win_of_the_week'],
  properties: {
    trend_interpretation: { type: 'string' },
    top_actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'time_to_ship_minutes'],
        properties: {
          action: { type: 'string' },
          time_to_ship_minutes: { type: 'number' },
        },
      },
    },
    win_of_the_week: { type: 'string' },
  },
});

module.exports = {
  adOptimizerAudit,
  leadResponse,
  qualityGateAdvisor,
  complianceRewrite,
  scorecardCommentary,
};
