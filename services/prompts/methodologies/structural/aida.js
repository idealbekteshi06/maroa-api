'use strict';

/**
 * AIDA — Attention, Interest, Desire, Action.
 *
 * The oldest structural framework in copywriting. First articulated by
 * Elias St. Elmo Lewis in 1898 to describe how an effective ad walks the
 * reader from "I noticed this" to "I bought this".
 *
 * Source: E. St. Elmo Lewis, "Catch-Line and Argument", 1898; later
 * popularized in Strong, "The Psychology of Selling and Advertising", 1925.
 *
 * Applicability: nearly everything customer-facing. Especially strong on:
 *   - cold ads (TOFU on Meta/Google)
 *   - long-form sales pages
 *   - cold email
 *
 * Where it gets misused: short-form social posts where the four-stage
 * structure forces unnatural pacing. For posts < 80 words, prefer a
 * single-beat structure (just attention or just action).
 */

const { _normalize, _wordCount, _containsAny, makeFix, applicability } = require('../_helpers');

const ATTENTION_MARKERS = [
  // First-sentence hooks that grab. Real working hooks across thousands
  // of high-performing ads.
  /^(why|how|what|did you|imagine|stop|here'?s|the secret|in just|this is)/i,
  /^[A-Z][^.!?]{3,80}[?!]/, // first sentence ends in ! or ? — high attention rate
  /^[A-Z][^.!?]{3,40}:/, // colon-led opener
  /\d/, // contains a number in the first ~15 words
];

const ACTION_MARKERS = [
  'buy',
  'shop',
  'order',
  'sign up',
  'subscribe',
  'join',
  'get started',
  'book',
  'reserve',
  'try',
  'download',
  'claim',
  'apply',
  'learn more',
  'see how',
  'start free',
  'request',
  'schedule',
  'contact',
  'reply',
];

const DESIRE_MARKERS = [
  // emotional / benefit language (not features)
  'imagine',
  'finally',
  'without',
  'no more',
  'instead of',
  'goodbye to',
  'enjoy',
  'love',
  'feel',
  'love how',
  'wake up',
  'never again',
  // outcome words
  'save',
  'gain',
  'reach',
  'become',
  'achieve',
  'unlock',
  'win',
];

const INTEREST_MARKERS = [
  // proof/credibility/intrigue elements that hold the reader
  'because',
  'so that',
  'which is why',
  'unlike',
  'unlike most',
  'unlike other',
  'most people',
  'in fact',
  'studies show',
  'we found',
  '%',
  'minutes',
  'days',
  'hours',
  'years',
];

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }
  const firstWords = draft.slice(0, 200);
  const fixes = [];

  // ATTENTION — first 200 chars should hit at least one attention marker
  const hasAttention =
    _containsAny(firstWords, ATTENTION_MARKERS) || (/^[A-Z]\w+/.test(firstWords) && firstWords.length > 0);
  if (!hasAttention) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'AIDA-A: opening fails to grab attention',
        suggestion: 'Open with a question, number, surprising claim, or vivid scene in the first sentence.',
      })
    );
  }

  // INTEREST — body must include a reason-why / proof element
  const hasInterest = _containsAny(draft, INTEREST_MARKERS);
  if (!hasInterest) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'AIDA-I: no reason-why / proof element to hold interest',
        suggestion: 'Add one specific number, "because", "unlike X", or "studies show".',
      })
    );
  }

  // DESIRE — emotional/outcome language
  const hasDesire = _containsAny(draft, DESIRE_MARKERS);
  if (!hasDesire) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'AIDA-D: no outcome / emotional language',
        suggestion: 'Add one outcome word ("save X minutes", "finally", "without Y") to spark desire.',
      })
    );
  }

  // ACTION — final 25% should contain a CTA verb. Skip if short post + TOFU.
  const tail = draft.slice(Math.floor(draft.length * 0.6));
  const hasAction = _containsAny(tail, ACTION_MARKERS);
  const skipActionCheck = _wordCount(draft) < 30 && context.funnel_stage === 'tofu';
  if (!hasAction && !skipActionCheck) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'AIDA-A: no action verb / CTA in the closing third',
        suggestion: 'End with a clear action: "Sign up free", "Order today", "Reserve your spot".',
      })
    );
  }

  // Score = fraction of stages present
  const stagesPresent = [hasAttention, hasInterest, hasDesire, hasAction || skipActionCheck].filter(Boolean).length;
  const score = stagesPresent / 4;

  return {
    score,
    fixes,
    reasoning: `AIDA stages present: ${stagesPresent}/4 (A:${hasAttention} I:${hasInterest} D:${hasDesire} A:${hasAction || skipActionCheck})`,
  };
}

function generateFromSpec({ product, audience, offer, channel } = {}) {
  return {
    structure: 'Attention → Interest → Desire → Action',
    prompt_segments: [
      `Open with ATTENTION: a question, number, or surprising claim about ${product || 'the offer'}.`,
      `Build INTEREST: one specific reason-why, proof element, or contrast vs the obvious alternative.`,
      `Trigger DESIRE: paint the outcome — what life looks like AFTER for ${audience || 'the customer'}.`,
      `Close with ACTION: a single, concrete CTA appropriate to ${channel || 'this channel'}.${offer ? ` Offer: ${offer}.` : ''}`,
    ],
  };
}

module.exports = {
  id: 'aida',
  name: 'AIDA — Attention, Interest, Desire, Action',
  category: 'structural',
  source_citation: 'E. St. Elmo Lewis, "Catch-Line and Argument" (1898)',
  applicability: applicability({
    awareness_stages: ['problem_aware', 'solution_aware', 'product_aware'],
    funnel_stages: ['tofu', 'mofu', 'bofu'],
    channels: ['*'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'A', rule: 'First sentence must grab attention', kind: 'must_have' },
    { id: 'I', rule: 'Body must include a reason-why / proof element', kind: 'must_have' },
    { id: 'D', rule: 'Must invoke desired outcome / emotion', kind: 'must_have' },
    { id: 'A2', rule: 'Must contain action verb / CTA (unless very short TOFU)', kind: 'must_have' },
  ],
  manipulation_risk: 2, // Classical structure; not inherently manipulative.
  applyToDraft,
  generateFromSpec,
};
