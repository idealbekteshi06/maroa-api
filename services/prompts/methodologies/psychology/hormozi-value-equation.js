'use strict';

/**
 * Hormozi Value Equation.
 *
 * Source: Alex Hormozi, "$100M Offers" (2021).
 *
 * Perceived value =
 *      (Dream Outcome × Perceived Likelihood of Achievement)
 *    ───────────────────────────────────────────────────────
 *      (Time Delay × Effort & Sacrifice)
 *
 * To make any offer "irresistible" you push the numerator UP and the
 * denominator DOWN. Each axis is independently movable, which is what
 * makes the framework useful for offer design specifically.
 *
 * Manipulation_risk = 4. The framework explicitly rejects fake-likelihood
 * inflation; the applyToDraft check flags unsupported claims of certainty.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const DREAM_OUTCOME_MARKERS = [
  'goal',
  'become',
  'achieve',
  'finally',
  'transform',
  'reach',
  'feel like',
  'wake up',
  'wake up to',
  'enjoy',
  'love how',
  'life where',
];

const LIKELIHOOD_MARKERS = [
  // Proof / specificity that makes the outcome feel achievable
  'studies show',
  'proven',
  'tested',
  '★',
  'customers',
  'used by',
  /\d+%/,
  /\d+ out of \d+/,
  'verified',
  'guarantee',
  'money back',
];

const TIME_REDUCTION_MARKERS = [
  'in minutes',
  'in seconds',
  'today',
  'in 24 hours',
  'in a week',
  'overnight',
  'instantly',
  'same-day',
  'within',
];

const EFFORT_REDUCTION_MARKERS = [
  'done-for-you',
  'we handle',
  'one-click',
  'we set up',
  'no setup',
  'no technical',
  'plug and play',
  'we do the work',
  'turnkey',
];

const UNSUPPORTED_CERTAINTY_FLAGS = [
  // Promises that need backing or they're misleading
  'guaranteed results',
  'guaranteed to work',
  'always works',
  'never fails',
  '100% success',
  'no exceptions',
  'no risk',
];

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }

  const fixes = [];
  const dream = _containsAny(draft, DREAM_OUTCOME_MARKERS);
  const likelihood = _containsAny(draft, LIKELIHOOD_MARKERS);
  const timeReduction = _containsAny(draft, TIME_REDUCTION_MARKERS);
  const effortReduction = _containsAny(draft, EFFORT_REDUCTION_MARKERS);

  // The numerator must be at least somewhat present — dream outcome OR
  // likelihood. Otherwise the value equation reads as zero.
  if (!dream && !likelihood) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Hormozi: no dream outcome AND no likelihood signal',
        suggestion: 'Add a vivid outcome statement OR a proof point. Without either, perceived value = 0.',
      })
    );
  }

  // Time + effort reduction are the secret sauce — at least one strongly
  // recommended for paid offers
  if (!timeReduction && !effortReduction && context.funnel_stage === 'bofu') {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Hormozi: no time-saving OR effort-reduction signal',
        suggestion: 'Add "in 5 minutes" or "we handle X for you". Reducing the denominator multiplies value.',
      })
    );
  }

  // Ethics check: unsupported certainty inflates likelihood dishonestly
  if (_containsAny(draft, UNSUPPORTED_CERTAINTY_FLAGS)) {
    const hasBackup = /\b(refund|guarantee period|money[- ]back|terms|conditions apply)\b/i.test(draft);
    if (!hasBackup) {
      fixes.push(
        makeFix({
          severity: 'block',
          issue: 'Hormozi ethics: certainty claim ("guaranteed results") without explicit backup',
          suggestion:
            'Either remove the absolute claim OR pair it with concrete guarantee terms (money-back, conditions).',
        })
      );
    }
  }

  const axesPresent = [dream, likelihood, timeReduction, effortReduction].filter(Boolean).length;
  const score = axesPresent / 4;

  return {
    score,
    fixes,
    reasoning: `value axes: dream=${dream} likelihood=${likelihood} time=${timeReduction} effort=${effortReduction}`,
  };
}

function generateFromSpec({ product, dream, audience, currentTime, currentEffort, proofPoints = [] } = {}) {
  return {
    structure: 'Hormozi value equation: (Dream × Likelihood) ÷ (Time × Effort)',
    prompt_segments: [
      `DREAM OUTCOME: paint where ${audience || 'the customer'} ends up — ${dream || 'the desired state'}. Be visual, specific, sensory.`,
      `LIKELIHOOD: prove it's achievable for THEM, not just in theory. Use: ${
        proofPoints.length ? proofPoints.join('; ') : 'specific customer numbers, reviews, or guarantees'
      }.`,
      `TIME DELAY: reduce it. Customer currently waits ${currentTime || 'a long time'}. With ${product || 'this'}, how fast can they get there?`,
      `EFFORT & SACRIFICE: reduce it. Customer currently has to ${currentEffort || 'do a lot of work'}. What does ${product || 'this'} take off their plate?`,
      'AVOID: unsupported certainty claims ("guaranteed to work"). Either back them with explicit terms or drop them.',
    ],
  };
}

module.exports = {
  id: 'hormozi-value-equation',
  name: 'Hormozi Value Equation',
  category: 'psychology',
  source_citation: 'Alex Hormozi, "$100M Offers" (2021)',
  applicability: applicability({
    awareness_stages: ['solution_aware', 'product_aware'],
    funnel_stages: ['mofu', 'bofu'],
    channels: ['landing-page-hero', 'landing-page-long', 'sales-page', 'email-promo', 'meta-ads-video', 'webinar'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'numerator', rule: 'Must include dream outcome AND/OR likelihood signal', kind: 'must_have' },
    { id: 'denominator-bofu', rule: 'BOFU offers should reduce time OR effort (one is enough)', kind: 'must_have' },
    {
      id: 'no-unsupported-certainty',
      rule: 'Absolute claims ("guaranteed to work") must be paired with concrete terms',
      kind: 'must_avoid',
    },
  ],
  manipulation_risk: 4,
  applyToDraft,
  generateFromSpec,
};
