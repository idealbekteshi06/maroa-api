'use strict';

/**
 * Ogilvy Rules — 38 rules from "Confessions of an Advertising Man" and
 * "Ogilvy on Advertising".
 *
 * Source: David Ogilvy, "Confessions of an Advertising Man" (1963),
 * "Ogilvy on Advertising" (1983).
 *
 * Ogilvy ran research-driven, long-form, headline-obsessed campaigns. His
 * rules (selected, distilled):
 *   - The headline does 80% of the work; spend the time there
 *   - Long copy outsells short copy (when there\'s something to say)
 *   - Specific claims beat superlatives; "I saw 4 hawks" beats "amazing wildlife"
 *   - Customers buy benefits, not features
 *   - Never write copy you wouldn\'t want your family to read
 *   - Picture > headline > body — but only if the picture is on-strategy
 *
 * Manipulation_risk = 2.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const SUPERLATIVES = ['best', 'finest', 'most advanced', 'world-class', 'unmatched', 'unparalleled'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const fixes = [];

  // Ogilvy hated superlatives without proof
  if (_containsAny(draft, SUPERLATIVES)) {
    const hasSpecificProof = /\d+%|\d+ years|study|survey/.test(draft);
    if (!hasSpecificProof) {
      fixes.push(
        makeFix({
          severity: 'block',
          issue: 'Ogilvy: superlatives ("best", "world-class") without specific proof',
          suggestion: 'Replace superlatives with specifics. "Best" → "rated 4.9/5 by 12,847 customers".',
        })
      );
    }
  }

  // Headline matters — first line should be longer than 4 words but not paragraph-length
  const firstLine = draft.split('\n')[0].trim();
  const firstLineWords = firstLine.split(/\s+/).filter(Boolean).length;
  if (firstLineWords < 3) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Ogilvy: headline too short to do its job',
        suggestion: 'Expand the headline — 6-12 words usually outperforms 2-3.',
      })
    );
  } else if (firstLineWords > 18) {
    fixes.push(
      makeFix({ severity: 'suggest', issue: 'Ogilvy: headline too long', suggestion: 'Tighten to ≤14 words.' })
    );
  }
  return { score: fixes.length === 0 ? 1.0 : 0.5, fixes, reasoning: `firstLineWords=${firstLineWords}` };
}

function generateFromSpec({ product, audience }) {
  return {
    structure: 'Ogilvy: headline does 80%; specifics beat superlatives',
    prompt_segments: [
      'HEADLINE: 6-12 words. Specific. Curiosity + benefit.',
      `Customers buy BENEFITS — translate every feature of ${product || 'the offer'} into what ${audience || 'the customer'} gains.`,
      'AVOID superlatives without proof. "Best" alone is empty.',
    ],
  };
}

module.exports = {
  id: 'ogilvy-rules',
  name: 'Ogilvy Rules',
  category: 'brand',
  source_citation: 'David Ogilvy, "Confessions of an Advertising Man" (1963), "Ogilvy on Advertising" (1983)',
  applicability: applicability({}),
  invariants: [{ id: 'specific-over-superlative', rule: 'Specifics > superlatives', kind: 'must_have' }],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
