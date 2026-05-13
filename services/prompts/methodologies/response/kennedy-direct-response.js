'use strict';

/**
 * Kennedy Direct Response Rules.
 *
 * Source: Dan Kennedy, "No B.S. Direct Marketing" (1996+). Kennedy
 * codified the operating rules of modern DR: every ad must be trackable,
 * have a single offer + single CTA + reason to act NOW.
 *
 * Kennedy\'s "no B.S." principles for DR:
 *   - There MUST be an offer (something specific being sold)
 *   - There MUST be a reason to respond NOW (not later)
 *   - You MUST tell them what to do, how to do it, when to do it
 *   - Track everything
 *
 * Manipulation_risk = 4. Kennedy is heavy on urgency — we flag fake urgency.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const OFFER_MARKERS = ['get', '$', '%', 'free', 'package', 'plan', 'tier', 'subscription'];
const REASON_NOW = ['ends', 'before', 'today', 'until', 'while supplies', 'first \\d+', 'last chance'];
const CTA_VERBS = ['order', 'sign up', 'buy', 'book', 'reserve', 'apply', 'request', 'call', 'click'];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const fixes = [];
  const hasOffer = _containsAny(draft, OFFER_MARKERS);
  const hasReasonNow = _containsAny(draft, REASON_NOW);
  const hasCta = _containsAny(draft, CTA_VERBS);

  if (!hasOffer)
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Kennedy: no clear offer',
        suggestion: 'State the specific thing being sold + price/tier.',
      })
    );
  if (!hasCta)
    fixes.push(
      makeFix({ severity: 'block', issue: 'Kennedy: no clear CTA', suggestion: 'Tell them what to do, how, when.' })
    );

  // Fake urgency check
  const fakeUrgencyFlags = /\b(today only|last chance|ends tonight|hurry)\b/i;
  const realUrgency = /\b(ends \w+ \d|until \w+ \d|only \d+ left|\d+ spots remaining)\b/i;
  if (fakeUrgencyFlags.test(draft) && !realUrgency.test(draft)) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Kennedy ethics: urgency language without a real deadline',
        suggestion: 'Replace "today only" with a real, named deadline. Or remove urgency entirely.',
      })
    );
  }
  const present = [hasOffer, hasReasonNow, hasCta].filter(Boolean).length;
  return { score: present / 3, fixes, reasoning: `Kennedy: offer${hasOffer} now${hasReasonNow} cta${hasCta}` };
}

function generateFromSpec({ offer, deadline, cta }) {
  return {
    structure: 'Kennedy DR rules: offer + reason-now + cta',
    prompt_segments: [
      `OFFER: ${offer || '[concrete thing + price/tier]'}.`,
      `REASON-NOW: ${deadline || '[real deadline or scarcity]'} — never fake urgency.`,
      `CTA: ${cta || '[verb + how + when]'}. Tell them exactly what to do.`,
    ],
  };
}

module.exports = {
  id: 'kennedy-direct-response',
  name: 'Kennedy Direct Response Rules',
  category: 'response',
  source_citation: 'Dan Kennedy, "No B.S. Direct Marketing" (1996+)',
  applicability: applicability({
    funnel_stages: ['bofu'],
    channels: ['email-promo', 'sales-page', 'landing-page-long', 'meta-ads-video'],
  }),
  invariants: [
    { id: 'offer', rule: 'Must include specific offer', kind: 'must_have' },
    { id: 'cta', rule: 'Must include clear CTA', kind: 'must_have' },
    { id: 'real-urgency', rule: 'Urgency must be real, not fabricated', kind: 'must_avoid' },
  ],
  manipulation_risk: 4,
  applyToDraft,
  generateFromSpec,
};
