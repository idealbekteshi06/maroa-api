'use strict';

/**
 * services/prompts/ad-optimizer/anti-slop.js
 * ----------------------------------------------------------------------------
 * Anti-cargo-cult vocabulary list. These are claims the auditor MUST NOT make
 * without quantitative evidence.
 *
 * Used as both:
 *   1. System-prompt instruction ("never say X without showing Y")
 *   2. Post-hoc validator on the JSON output (if a forbidden phrase appears
 *      without a citation, downgrade severity or reject the response)
 * ----------------------------------------------------------------------------
 */

/**
 * Each rule:
 *   pattern   — RegExp the LLM output is searched for
 *   requires  — array of citation field names that must be present in the
 *               same recommendation/issue object
 *   message   — human-readable rule (for the system-prompt section)
 */
const ANTI_SLOP_RULES = [
  {
    id: 'roas_drop_unqualified',
    pattern: /\broas\s+(dropped|fell|declined|crashed|tanked)\b/i,
    requires: ['sample_size', 'comparison_period'],
    message: 'Never claim ROAS dropped without showing the sample size AND comparison period.',
  },
  {
    id: 'ctr_low_unqualified',
    pattern: /\bctr\s+is\s+(low|poor|bad|weak)\b/i,
    requires: ['regional_benchmark'],
    message: 'Never call CTR "low" without citing the regional benchmark for this market + industry.',
  },
  {
    id: 'frequency_high_unqualified',
    pattern: /\bfrequency\s+is\s+(high|excessive|too\s+much)\b/i,
    requires: ['campaign_objective', 'platform_context'],
    message: 'Never flag frequency as high without context: retargeting tolerates 4+, prospecting flags at 2.5+.',
  },
  {
    id: 'audience_fatigue_unqualified',
    pattern: /\b(audience|ad)\s+fatigue\b/i,
    requires: ['frequency_value', 'ctr_decline_trend'],
    message: 'Audience fatigue requires BOTH frequency >3 AND a CTR-decline trend over 7+ days.',
  },
  {
    id: 'creative_stale_unqualified',
    pattern: /\bcreative\s+(is\s+)?(stale|tired|burned\s+out|fatigued)\b/i,
    requires: ['frequency_trajectory', 'ctr_decline_trend'],
    message: 'Creative-stale requires frequency-trajectory escalating AND CTR-decline trend.',
  },
  {
    id: 'cpa_high_unqualified',
    pattern: /\b(cpa|cost.per.acquisition)\s+is\s+(high|too\s+high|expensive)\b/i,
    requires: ['target_cpa', 'industry_avg_cpa'],
    message: 'Never call CPA "high" without target_cpa or industry_avg_cpa for comparison.',
  },
  {
    id: 'spend_inefficient_unqualified',
    pattern: /\b(wasted|wasting|inefficient)\s+spend\b/i,
    requires: ['specific_audience_segment', 'measured_outcome'],
    message: 'Wasted-spend claims require pointing to a specific audience/placement AND its measured outcome.',
  },
  {
    id: 'pause_immediately',
    pattern: /\bpause\s+(immediately|now|asap|right\s+away)\b/i,
    requires: ['statistical_significance', 'no_learning_phase_violation'],
    message: 'Urgent-pause language requires statistical significance + confirmation campaign is NOT in learning.',
  },
  {
    id: 'scale_aggressively',
    pattern: /\b(scale\s+aggressively|double\s+budget|triple\s+budget|10x|massively\s+scale)\b/i,
    requires: ['7day_roas_trend', 'no_learning_phase_violation'],
    message: 'Aggressive-scale language requires sustained ROAS trend over 7+ days AND not in learning phase.',
  },
  {
    id: 'kill_kill_kill',
    pattern: /\b(kill\s+it|kill\s+the\s+ad|nuke|trash\s+this)\b/i,
    requires: ['statistical_significance'],
    message: 'Hostile pause language is bad UX for SMB owners — use neutral "pause" with reason.',
  },
];

/**
 * Build the anti-slop section of the system prompt.
 * Lists every rule so the LLM knows what NOT to do.
 */
function buildAntiSlopSystemSection() {
  const lines = [
    'ANTI-CARGO-CULT RULES — never claim these without the listed evidence:',
    '',
  ];
  for (const rule of ANTI_SLOP_RULES) {
    lines.push(`- ${rule.message}`);
  }
  lines.push('');
  lines.push('Cargo-cult marketing language reduces trust. Every quantitative claim MUST cite the underlying metric in the citations array.');
  return lines.join('\n');
}

/**
 * Validate a parsed audit response. Returns array of violations.
 * Caller decides whether to reject, downgrade severity, or merely log.
 */
function validateAuditResponse(audit) {
  const violations = [];
  if (!audit || typeof audit !== 'object') return violations;

  // Concatenate all human-readable text fields for scanning.
  const text = [
    audit.decision_reason || '',
    ...(audit.critical_issues || []).map(i => `${i.fix || ''} ${i.note || ''}`),
    ...(audit.warnings || []).map(w => `${w.fix || ''} ${w.note || ''}`),
    ...(audit.opportunities || []).map(o => `${o.note || ''}`),
  ].join(' ');

  for (const rule of ANTI_SLOP_RULES) {
    if (rule.pattern.test(text)) {
      const citations = audit.citations || [];
      const has = (field) => citations.some(c => c[field] != null && c[field] !== '');
      const missing = rule.requires.filter(req => !has(req));
      if (missing.length) {
        violations.push({
          rule_id: rule.id,
          missing_citations: missing,
          phrase_caught: text.match(rule.pattern)?.[0],
        });
      }
    }
  }
  return violations;
}

module.exports = {
  ANTI_SLOP_RULES,
  buildAntiSlopSystemSection,
  validateAuditResponse,
};
