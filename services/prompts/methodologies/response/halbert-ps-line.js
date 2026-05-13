'use strict';

/**
 * Halbert PS Line — the PS as second-most-read element.
 *
 * Source: Gary Halbert, "The Boron Letters" (1984+) and his newsletter
 * archive. Halbert\'s rule: readers of a long letter scan the headline,
 * then the PS, then decide whether to read the rest. The PS does double
 * duty: it summarizes the offer + adds urgency or a bonus.
 *
 * Applies to: long-form emails, direct-mail letters, sales pages.
 *
 * Manipulation_risk = 2.
 */

const { _wordCount, makeFix, applicability } = require('../_helpers');

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const wc = _wordCount(draft);
  // Only applies to long-form
  if (wc < 200) return { score: 0.5, fixes: [], reasoning: 'short copy — PS not expected' };
  const hasPS = /^\s*p\.?s\.?[\s:.\-]/im.test(draft);
  const fixes = [];
  if (!hasPS) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Halbert: long-form copy without a PS',
        suggestion:
          'Add a "P.S." summarizing the offer + a single urgency or bonus point. Readers see it after the headline.',
      })
    );
  }
  return { score: hasPS ? 1.0 : 0.3, fixes, reasoning: `wordCount=${wc} hasPS=${hasPS}` };
}

function generateFromSpec({ offer, urgency }) {
  return {
    structure: 'PS line after the close',
    prompt_segments: [
      `Close with a P.S. that summarizes ${offer || 'the offer'} and adds ${urgency || 'one urgency or bonus point'}.`,
      'Format: "P.S. [one-sentence summary]. [Urgency or bonus]."',
    ],
  };
}

module.exports = {
  id: 'halbert-ps-line',
  name: 'Halbert PS Line',
  category: 'response',
  source_citation: 'Gary Halbert, "The Boron Letters" (1984+)',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    channels: ['email-cold', 'email-promo', 'email-nurture', 'sales-page'],
  }),
  invariants: [{ id: 'ps', rule: 'Long-form copy should include a PS', kind: 'must_have' }],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
