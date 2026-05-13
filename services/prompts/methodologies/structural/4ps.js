'use strict';

/**
 * 4Ps — Picture, Promise, Prove, Push.
 *
 * Source: Henry Hoke Sr., "The Reporter of Direct Mail Advertising" (1947).
 * One of the oldest formal DR formulas.
 *
 * PICTURE: paint a vivid scene the reader sees themselves in.
 * PROMISE: tell them what the offer delivers.
 * PROVE: back it up with proof.
 * PUSH: ask for the action with urgency.
 *
 * Manipulation_risk = 3.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const PICTURE = ['imagine', 'picture this', 'you wake up', 'you walk in', 'visualize'];
const PROMISE = ['will', 'get', 'become', 'enjoy', 'finally', 'gain'];
const PROVE = ['customers', 'reviews', 'study', 'guarantee', '★', '%', /\d{2,}/];
const PUSH = ['today', 'now', 'before', 'ends', 'last chance', 'order', 'sign up'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const pic = _containsAny(draft, PICTURE);
  const pro = _containsAny(draft, PROMISE);
  const prov = _containsAny(draft, PROVE);
  const push = _containsAny(draft, PUSH);
  const present = [pic, pro, prov, push].filter(Boolean).length;
  const fixes = [];
  if (!prov)
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: '4Ps: promise without proof',
        suggestion: 'Add a customer count, percentage, or guarantee.',
      })
    );
  return { score: present / 4, fixes, reasoning: `4Ps: P${pic} P${pro} P${prov} P${push}` };
}

function generateFromSpec({ outcome, proof, urgency }) {
  return {
    structure: 'Picture → Promise → Prove → Push',
    prompt_segments: [
      `PICTURE: open with a vivid scene the reader steps into.`,
      `PROMISE: state the outcome clearly — ${outcome || 'the deliverable'}.`,
      `PROVE: back it with ${proof || 'numbers, customers, reviews, or guarantee'}.`,
      `PUSH: ask for the action with ${urgency || 'a real deadline or scarcity'}.`,
    ],
  };
}

module.exports = {
  id: '4ps',
  name: '4Ps — Picture, Promise, Prove, Push',
  category: 'structural',
  source_citation: 'Henry Hoke Sr. (1947)',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    channels: ['email-promo', 'sales-page', 'landing-page-long'],
  }),
  invariants: [{ id: 'prove', rule: 'Must include proof', kind: 'must_have' }],
  manipulation_risk: 3,
  applyToDraft,
  generateFromSpec,
};
