'use strict';

/**
 * Edelman Trust Decline — modern trust signals.
 *
 * Source: Edelman Trust Barometer (annual research, 2001–present).
 *
 * Findings repeated since the 2010s:
 *   - Trust in institutions (government, media, business) is declining
 *   - Trust in "people like me" / peer voices is rising
 *   - Founder/employee voices outperform brand voices
 *   - Specifics + transparency outperform polish + claims
 *
 * Implication for copy: lean on peer testimonials, founder POV,
 * transparency ("here\'s how we built this", "here\'s what didn\'t work"),
 * not corporate-voice authority.
 *
 * Manipulation_risk = 1.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const TRUST_NEGATIVE = ['our brand', 'as a company', 'we are committed to', 'industry-leading', 'best-in-class'];
const TRUST_POSITIVE = [
  'i',
  'we built this',
  'our founder',
  'a customer',
  'transparently',
  "here's how",
  "didn't work",
  'we learned',
];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const corp = _containsAny(draft, TRUST_NEGATIVE);
  const peer = _containsAny(draft, TRUST_POSITIVE);
  const fixes = [];
  if (corp && !peer) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Edelman: corporate-voice signals dominate',
        suggestion:
          'Add peer voice / founder POV / transparency. "We built this because..." > "We are committed to...".',
      })
    );
  }
  return { score: peer ? 1.0 : corp ? 0.4 : 0.6, fixes, reasoning: `corp=${corp} peer=${peer}` };
}

function generateFromSpec({ voice = 'founder' }) {
  return {
    structure: 'Edelman: peer/founder voice over corporate voice',
    prompt_segments: [
      `VOICE: ${voice}. Write in first person ("I built this because...").`,
      "Add at least one transparency moment: what didn't work, what you learned, what you're still figuring out.",
      'AVOID "industry-leading", "best-in-class", "we are committed to" — these trigger distrust.',
    ],
  };
}

module.exports = {
  id: 'edelman-trust-decline',
  name: 'Edelman Trust Signals',
  category: 'modern',
  source_citation: 'Edelman Trust Barometer (annual, 2001+)',
  applicability: applicability({}),
  invariants: [{ id: 'peer-over-corp', rule: 'Peer/founder voice beats corporate voice', kind: 'must_have' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
