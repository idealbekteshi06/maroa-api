'use strict';

/**
 * Reeves USP — Unique Selling Proposition.
 *
 * Source: Rosser Reeves, "Reality in Advertising" (1961). Reeves was
 * the creative director who ran Ted Bates & Company and championed
 * a hard rule: every ad must offer ONE proposition, that ONE proposition
 * must be something the competition cannot or does not offer, and it
 * must move the masses (be desirable + valuable).
 *
 * The 3 Reeves rules:
 *   1. Each ad must make a proposition to the consumer.
 *   2. The proposition must be unique — competition can't/doesn't offer it.
 *   3. The proposition must be strong enough to move masses.
 *
 * Manipulation_risk = 2. The framework demands honesty about
 * differentiation.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const GENERIC_CLAIMS = [
  'high quality',
  'best in class',
  'world-class',
  'industry-leading',
  'cutting-edge',
  'innovative',
];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const fixes = [];

  // Generic claims = USP failure. "High quality" is what everyone says.
  if (_containsAny(draft, GENERIC_CLAIMS)) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Reeves USP: generic claims that the competition could copy verbatim',
        suggestion:
          'Replace "high quality" / "industry-leading" with a SPECIFIC proposition the competition can\'t make.',
      })
    );
  }

  // Differentiation marker — "only", "unlike", "instead of"
  const hasDifferentiator = /\b(only \w+ (that|who)|unlike|the only|none of|nobody else)\b/i.test(draft);
  if (!hasDifferentiator) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Reeves USP: no explicit differentiator',
        suggestion: 'State explicitly what nobody else does. "We\'re the only X that Y."',
      })
    );
  }
  return {
    score: !_containsAny(draft, GENERIC_CLAIMS) && hasDifferentiator ? 1.0 : 0.4,
    fixes,
    reasoning: `generic=${_containsAny(draft, GENERIC_CLAIMS)} differentiator=${hasDifferentiator}`,
  };
}

function generateFromSpec({ proposition, differentiator }) {
  return {
    structure: 'Reeves USP — one proposition, unique, strong',
    prompt_segments: [
      `PROPOSITION: ${proposition || '[the specific benefit you offer]'} — ONE claim, not five.`,
      `DIFFERENTIATOR: ${differentiator || '[what nobody else does]'} — state this explicitly.`,
      'AVOID generic adjectives. "High quality" is not a USP. "Hand-built by 12 craftspeople in Maine" is.',
    ],
  };
}

module.exports = {
  id: 'reeves-usp',
  name: 'Reeves USP — Unique Selling Proposition',
  category: 'proof',
  source_citation: 'Rosser Reeves, "Reality in Advertising" (1961)',
  applicability: applicability({}),
  invariants: [
    { id: 'unique', rule: "Proposition must be something competition can't claim", kind: 'must_have' },
    { id: 'no-generic', rule: 'No "high quality" / "best in class" filler', kind: 'must_avoid' },
  ],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
