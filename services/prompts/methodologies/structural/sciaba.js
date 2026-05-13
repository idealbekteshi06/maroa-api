'use strict';

/**
 * SCIPABA — Situation, Complication, Implication, Position, Action,
 * Benefit, Action.
 *
 * Consulting-grade extension of SPIN (Rackham, 1988) for enterprise B2B
 * decks and sales narratives. The two "Action" steps separate the
 * recommended action from the call to action.
 *
 * Source: McKinsey/Bain narrative tradition; codified across multiple
 * consulting playbooks.
 *
 * Manipulation_risk = 1. Pure analytical structure.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const SITUATION = ['today', 'currently', 'right now', 'the state of'];
const COMPLICATION = ['however', 'but', 'unfortunately', 'the challenge', 'the issue'];
const IMPLICATION = ['this means', 'so', 'as a result', 'consequently'];
const POSITION = ['we believe', 'our approach', 'the answer', 'we propose'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const s = _containsAny(draft, SITUATION);
  const c = _containsAny(draft, COMPLICATION);
  const i = _containsAny(draft, IMPLICATION);
  const p = _containsAny(draft, POSITION);
  const present = [s, c, i, p].filter(Boolean).length;
  const fixes = [];
  if (present < 3) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'SCIPABA: missing analytical stages',
        suggestion: 'Walk situation → complication → implication → position → action.',
      })
    );
  }
  return { score: present / 4, fixes, reasoning: `SCIPABA stages: ${present}/4` };
}

function generateFromSpec({ situation, complication, position, action }) {
  return {
    structure: 'Situation → Complication → Implication → Position → Action → Benefit → Action',
    prompt_segments: [
      `SITUATION: ${situation || 'where the market / customer is today'}.`,
      `COMPLICATION: ${complication || "what's changing or breaking"}.`,
      `IMPLICATION: what this means for the customer, in concrete terms.`,
      `POSITION: ${position || 'our recommended path'}.`,
      `ACTION: the specific intervention. BENEFIT: the measurable outcome. ACTION: what we\'re asking for now (${action || 'the meeting / contract / signature'}).`,
    ],
  };
}

module.exports = {
  id: 'sciaba',
  name: 'SCIPABA — Situation/Complication/Implication/Position/Action/Benefit/Action',
  category: 'structural',
  source_citation: 'McKinsey/Bain narrative tradition; extends SPIN Selling (Rackham, 1988)',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    channels: ['linkedin-article', 'sales-page', 'email-cold', 'webinar', 'press-release'],
    industries: ['saas_b2b', 'consulting_firm', 'agency_b2b', 'financial_advisor'],
  }),
  invariants: [{ id: 'analytical', rule: 'Must walk SCI before P', kind: 'must_have' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
