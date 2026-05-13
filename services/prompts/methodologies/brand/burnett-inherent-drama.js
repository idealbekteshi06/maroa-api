'use strict';

/**
 * Burnett Inherent Drama — find the drama already in the product.
 *
 * Source: Leo Burnett (founder, Leo Burnett Co., 1935). Burnett\'s creed:
 * every product has "inherent drama" — find it instead of inventing it.
 *
 * Famous examples: Marlboro Cowboy (the actual western frontier),
 * Jolly Green Giant (the abundance of the valley), Pillsbury Doughboy
 * (the warmth of baking at home). None invented. All amplified.
 *
 * Modern application: don\'t add features the product doesn\'t have; amplify
 * the ones that are already there.
 *
 * Manipulation_risk = 1.
 */

const { makeFix, applicability } = require('../_helpers');

const FABRICATION_FLAGS = ['imagine if', 'one day this product will', 'in the future', 'someday'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const hasFabrication = FABRICATION_FLAGS.some((p) => draft.toLowerCase().includes(p));
  const fixes = [];
  if (hasFabrication) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: "Burnett: language suggests inventing drama vs. amplifying what's real",
        suggestion: "Strip future-tense fabrication. What does the product ALREADY do that's dramatic?",
      })
    );
  }
  return { score: hasFabrication ? 0.4 : 1.0, fixes, reasoning: `fabrication=${hasFabrication}` };
}

function generateFromSpec({ product, real_origin, real_process }) {
  return {
    structure: 'Find the drama already in the product',
    prompt_segments: [
      `What is ALREADY dramatic about ${product || 'this product'}?`,
      real_origin ? `Origin: ${real_origin}. Amplify this — don\'t invent.` : '',
      real_process ? `Process: ${real_process}.` : '',
      "AVOID future-tense fabrication. Stay in what's real today.",
    ].filter(Boolean),
  };
}

module.exports = {
  id: 'burnett-inherent-drama',
  name: 'Burnett Inherent Drama',
  category: 'brand',
  source_citation: 'Leo Burnett, Leo Burnett Co. (1935+)',
  applicability: applicability({}),
  invariants: [{ id: 'real-drama', rule: 'Drama must come from real product attributes', kind: 'must_have' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
