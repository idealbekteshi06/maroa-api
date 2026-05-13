'use strict';

/**
 * FAB — Features, Advantages, Benefits.
 *
 * The B2B sales canonical translation framework. A FEATURE is what the
 * product is/has. An ADVANTAGE is what that feature does. A BENEFIT is
 * what that means for the customer's life or work.
 *
 * Source: rooted in IBM + Xerox B2B sales training (1960s-70s);
 * popularized in Neil Rackham, "SPIN Selling" (1988) which critiques
 * the framework but cements its vocabulary.
 *
 * Power: prevents the "feature dump" failure mode that kills B2B copy.
 * Limitation: most copywriters skip directly to benefits and bury
 * features — FAB forces explicit translation through advantages.
 *
 * Manipulation_risk = 1. Pure clarity framework.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const FEATURE_MARKERS = ['has', 'with', 'includes', 'built-in', 'supports', 'comes with'];
const ADVANTAGE_MARKERS = ['so you can', 'which means', 'that means', 'so that', 'allowing you to'];
const BENEFIT_MARKERS = ['save', 'win', 'grow', 'never', 'finally', 'reduce', 'increase', 'free up'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const hasF = _containsAny(draft, FEATURE_MARKERS);
  const hasA = _containsAny(draft, ADVANTAGE_MARKERS);
  const hasB = _containsAny(draft, BENEFIT_MARKERS);
  const fixes = [];
  if (hasF && !hasA && !hasB)
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'FAB: feature dump without translation',
        suggestion: 'Translate every feature → advantage → benefit.',
      })
    );
  const present = [hasF, hasA, hasB].filter(Boolean).length;
  return { score: present / 3, fixes, reasoning: `FAB: F${hasF} A${hasA} B${hasB}` };
}

function generateFromSpec({ features = [] }) {
  return {
    structure: 'Feature → Advantage → Benefit',
    prompt_segments: [
      'For EACH feature, write the full F→A→B chain. Do not stop at features.',
      ...features.map(
        (f) =>
          `  • Feature: ${f} → Advantage: (what it does) → Benefit: (what it means for the customer\'s day-to-day).`
      ),
    ],
  };
}

module.exports = {
  id: 'fab',
  name: 'FAB — Features, Advantages, Benefits',
  category: 'structural',
  source_citation: 'B2B sales canon (IBM/Xerox, 1960s); cited in Neil Rackham, "SPIN Selling" (1988)',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    industries: ['saas_b2b', 'agency_b2b', 'consulting_firm'],
  }),
  invariants: [{ id: 'translate', rule: 'Features must be translated to benefits via advantages', kind: 'must_have' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
