'use strict';

/**
 * Bernbach Creative Revolution — surprise, simplicity, single idea.
 *
 * Source: Bill Bernbach, founder of DDB (1949), led the "Creative
 * Revolution" of the 1960s. Most famous campaigns: VW "Think small",
 * Avis "We try harder", Levy\'s rye bread.
 *
 * Bernbach\'s rules:
 *   - Surprise the reader (defy the category convention)
 *   - One idea per ad, executed simply
 *   - Honesty beats hype — the VW Beetle was small, Avis WAS #2
 *   - Visual + headline must be inseparable (each amplifies the other)
 *
 * Manipulation_risk = 1.
 */

const { _wordCount, makeFix, applicability } = require('../_helpers');

const HYPE_WORDS = ['amazing', 'incredible', 'revolutionary', 'game-changing', 'next-generation', 'breakthrough'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const wc = _wordCount(draft);
  const fixes = [];

  const hasHype = HYPE_WORDS.some((w) => draft.toLowerCase().includes(w));
  if (hasHype) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Bernbach: hype words ("amazing", "revolutionary") — honesty beats hype',
        suggestion: 'Replace with what specifically makes it different. The truth, said well, is more interesting.',
      })
    );
  }
  return { score: !hasHype && wc >= 20 ? 1.0 : 0.5, fixes, reasoning: `hype=${hasHype} wc=${wc}` };
}

function generateFromSpec({ category_convention, our_break }) {
  return {
    structure: 'Bernbach: surprise, simplicity, single idea',
    prompt_segments: [
      `Surprise the reader by defying ${category_convention || "the category's default approach"}.`,
      `OUR BREAK: ${our_break || 'what we do differently'}. State it plainly. Honesty over hype.`,
      'ONE IDEA per piece — not three.',
    ],
  };
}

module.exports = {
  id: 'bernbach-creative-revolution',
  name: 'Bernbach Creative Revolution',
  category: 'brand',
  source_citation: 'Bill Bernbach, DDB (1949+); "Think small" campaign (1959)',
  applicability: applicability({}),
  invariants: [{ id: 'no-hype', rule: 'No hype words; truth beats puffery', kind: 'must_avoid' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
