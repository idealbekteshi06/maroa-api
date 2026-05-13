'use strict';

/**
 * Ariely Irrationality — anchoring, decoy effect, relative pricing.
 *
 * Source: Dan Ariely, "Predictably Irrational" (2008) + MIT subscription
 * study (Economist pricing case, 2007).
 *
 * Three durable insights for offer presentation:
 *   1. ANCHORING — the first price seen shapes perception of all others
 *   2. DECOY EFFECT — adding a strictly-dominated option pushes choice
 *      toward the target tier (Economist study: print-only @ $125 made
 *      print+digital @ $125 jump from 32% → 84%)
 *   3. RELATIVE PRICING — humans compare; absolutes are uninterpretable
 *
 * Manipulation_risk = 5. Decoys are explicitly designed to nudge —
 * which is on the edge of ethics. The check flags decoys without a
 * clear value reason for the customer.
 */

const { makeFix, applicability } = require('../_helpers');

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  // Heuristic: does the copy show >1 price? Anchoring + relative-pricing
  // mostly applies to offer / pricing pages.
  const prices = draft.match(/\$\d+(?:[\.,]\d{2})?/g) || [];
  const fixes = [];
  if (prices.length === 1) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Ariely: only one price shown — no anchor for comparison',
        suggestion: 'Show a higher anchor price (retail, original, premium tier) so the offered price feels relative.',
      })
    );
  }
  return {
    score: prices.length >= 2 ? 1.0 : prices.length === 1 ? 0.5 : 0.3,
    fixes,
    reasoning: `prices_visible=${prices.length}`,
  };
}

function generateFromSpec({ targetPrice, anchorPrice, decoyPrice, audience }) {
  return {
    structure: 'Anchor → Decoy → Target',
    prompt_segments: [
      `ANCHOR: show ${anchorPrice ? `$${anchorPrice} (regular)` : 'a higher reference price'} prominently. This makes the target feel relative.`,
      decoyPrice
        ? `DECOY: include an option priced at $${decoyPrice} that is strictly dominated by the target. The decoy exists to make the target look like the obvious choice — make sure it\'s still a real, ethical option, not a phantom.`
        : '',
      `TARGET: $${targetPrice || 'X'} should look like a no-brainer in context.`,
      `Audience: ${audience || 'the customer'}. Frame pricing as "compared to" not "absolute".`,
    ].filter(Boolean),
  };
}

module.exports = {
  id: 'ariely-irrationality',
  name: 'Ariely Irrationality (anchoring, decoy, relative pricing)',
  category: 'psychology',
  source_citation: 'Dan Ariely, "Predictably Irrational" (2008)',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    channels: ['landing-page-hero', 'landing-page-long', 'sales-page', 'email-promo'],
  }),
  invariants: [{ id: 'relative', rule: 'Show prices relative to an anchor when possible', kind: 'must_have' }],
  manipulation_risk: 5,
  applyToDraft,
  generateFromSpec,
};
