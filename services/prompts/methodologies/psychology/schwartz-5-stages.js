'use strict';

/**
 * Schwartz 5 Stages of Awareness.
 *
 * Source: Eugene Schwartz, "Breakthrough Advertising" (1966).
 *
 * The most foundational psychology framework in copywriting. Maps WHERE
 * the customer is on the awareness journey, which dictates EVERYTHING
 * about how you address them. A "Most Aware" customer wants the offer
 * directly; an "Unaware" customer would run from the same opener.
 *
 * The 5 stages:
 *   1. UNAWARE         — doesn't know the problem exists. Sell with a
 *                         story or pattern interrupt, never with the product.
 *   2. PROBLEM-AWARE   — knows the pain, doesn't know solutions exist.
 *                         Lead with the pain in the customer's own words.
 *   3. SOLUTION-AWARE  — knows solutions exist, comparing options. Lead
 *                         with what makes yours different.
 *   4. PRODUCT-AWARE   — knows your product, hasn't bought. Lead with the
 *                         offer, the price, the proof, the urgency.
 *   5. MOST-AWARE      — past customer or convinced prospect. Lead with
 *                         the offer alone. Skip the persuasion.
 *
 * Schwartz: "If your prospect knows about your product and has
 * acknowledged he wants it, you simply put the product in the headline."
 *
 * Manipulation_risk = 2. Awareness mapping is descriptive, not manipulative.
 * Misuse risk comes from targeting the wrong stage (e.g. running BOFU copy
 * to a TOFU audience) — addressed by the stage router (S2).
 */

const { _normalize, _containsAny, makeFix, applicability } = require('../_helpers');

const STAGES = Object.freeze({
  UNAWARE: 'unaware',
  PROBLEM_AWARE: 'problem_aware',
  SOLUTION_AWARE: 'solution_aware',
  PRODUCT_AWARE: 'product_aware',
  MOST_AWARE: 'most_aware',
});

// Signals in the draft that suggest which stage it's targeting.
// Used to detect drift (e.g. draft mixes BOFU urgency + TOFU education).
const STAGE_SIGNALS = {
  unaware: ['imagine', 'a story', 'curious', 'did you know', 'interesting', "most people don't realize"],
  problem_aware: ['tired of', 'frustrated', 'sick of', 'struggle', 'pain', 'problem', 'why does'],
  solution_aware: ['unlike', 'better than', 'instead of', 'compared to', 'most tools', 'most solutions'],
  product_aware: ['our', 'we built', 'try', 'sign up', 'free trial', 'features', 'pricing'],
  most_aware: ['buy now', 'order', '50% off', 'last chance', 'ends tonight', 'reserve yours', 'add to cart'],
};

// Headline opener templates per stage. Used by generateFromSpec.
const OPENER_TEMPLATES = {
  unaware: [
    'A story about <character> who discovered <surprise>...',
    'What if everything you knew about <topic> was wrong?',
    'I used to think <X>. Then <surprising event>.',
  ],
  problem_aware: [
    'Tired of <pain>?',
    'Why does <pain> keep happening to <audience>?',
    "The real reason <audience> can't <achieve>",
  ],
  solution_aware: [
    'Why <our product> beats <category leader>',
    '<our product> vs <competitor> — the difference matters',
    "Most <category> tools force you to <pain>. Ours doesn't.",
  ],
  product_aware: [
    'Get <product> for <price> — <key benefit>',
    'Start your free trial of <product> in 60 seconds',
    "Here's exactly what you get with <product>",
  ],
  most_aware: [
    '<product> — <price> — order now',
    'Your favorite is back: <product>, <urgency>',
    'Re-order in one click',
  ],
};

/**
 * Detect which stage(s) a draft appears to target. Returns dominant stage
 * + confidence + warnings if multiple stages are mixed (which usually
 * indicates muddled copy).
 */
function detectStage(draft) {
  if (!draft || typeof draft !== 'string') {
    return { dominant: null, confidence: 0, signals_by_stage: {}, mixed: false };
  }
  const signalsByStage = {};
  let max = 0;
  let dominant = null;
  for (const [stage, signals] of Object.entries(STAGE_SIGNALS)) {
    let count = 0;
    for (const s of signals) {
      if (_containsAny(draft, [s])) count++;
    }
    signalsByStage[stage] = count;
    if (count > max) {
      max = count;
      dominant = stage;
    }
  }
  const total = Object.values(signalsByStage).reduce((a, b) => a + b, 0);
  const confidence = total === 0 ? 0 : max / total;
  // Mixed = more than one stage has ≥ 2 signals
  const mixed = Object.values(signalsByStage).filter((c) => c >= 2).length > 1;
  return { dominant, confidence, signals_by_stage: signalsByStage, mixed };
}

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }
  const detection = detectStage(draft);
  const fixes = [];
  const target = context.awareness_stage;

  // If caller specified a target stage, verify the draft matches it
  if (target) {
    if (!detection.dominant) {
      fixes.push(
        makeFix({
          severity: 'suggest',
          issue: `Schwartz: no clear stage signals — could be any awareness level`,
          suggestion: `Target was ${target}. Use openers / language patterns from that stage.`,
        })
      );
    } else if (detection.dominant !== target) {
      fixes.push(
        makeFix({
          severity: 'block',
          issue: `Schwartz: draft signals "${detection.dominant}" but target is "${target}"`,
          suggestion: `Rewrite using ${target}-appropriate openers and language. ${OPENER_TEMPLATES[target][0]}`,
        })
      );
    }
  }

  // Always flag mixed stages — confuses customers + dilutes response
  if (detection.mixed) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Schwartz: copy mixes multiple awareness stages',
        suggestion: 'Pick ONE stage and align the entire piece to it. Mixed copy reads as muddled.',
      })
    );
  }

  // Score: 1.0 if dominant matches target; 0.5 if dominant exists but no target;
  // 0.3 if no signals; 0.0 if mismatched.
  let score;
  if (!detection.dominant) score = 0.3;
  else if (!target) score = 0.6;
  else if (detection.dominant === target) score = 1.0;
  else score = 0.0;

  return {
    score,
    fixes,
    reasoning: `dominant=${detection.dominant} target=${target || 'none'} confidence=${detection.confidence.toFixed(2)} mixed=${detection.mixed}`,
  };
}

function generateFromSpec({ stage, product, audience, painPoint, offer } = {}) {
  const s = stage || 'problem_aware';
  const templates = OPENER_TEMPLATES[s] || OPENER_TEMPLATES.problem_aware;
  return {
    structure: `Schwartz awareness stage: ${s}`,
    prompt_segments: [
      `AWARENESS STAGE: ${s.toUpperCase()}.`,
      `For ${s}, the customer ${_stageDescription(s)}.`,
      `OPENER: use one of these templates (filled with real specifics): ${templates.join(' OR ')}`,
      `LANGUAGE: tilt toward ${s} signals (${STAGE_SIGNALS[s].slice(0, 3).join(', ')}).`,
      s === 'unaware' || s === 'problem_aware'
        ? 'AVOID: product names, prices, "sign up", direct CTAs. The customer isn\'t ready.'
        : s === 'most_aware'
          ? "INCLUDE: product, price, urgency. Skip persuasion. They're ready."
          : '',
    ].filter(Boolean),
  };
}

function _stageDescription(stage) {
  switch (stage) {
    case 'unaware':
      return 'does not know the problem exists. Lead with a story or pattern interrupt, never with the product';
    case 'problem_aware':
      return "knows the pain, doesn't know solutions exist. Lead with the pain in their own words";
    case 'solution_aware':
      return 'knows solutions exist, comparing options. Lead with what makes yours different';
    case 'product_aware':
      return "knows your product, hasn't bought. Lead with the offer, price, proof, urgency";
    case 'most_aware':
      return 'past customer or convinced prospect. Lead with the offer alone. Skip the persuasion';
    default:
      return '';
  }
}

module.exports = {
  id: 'schwartz-5-stages',
  name: 'Schwartz 5 Stages of Awareness',
  category: 'psychology',
  source_citation: 'Eugene Schwartz, "Breakthrough Advertising" (1966)',
  applicability: applicability({
    awareness_stages: ['*'],
    funnel_stages: ['*'],
    channels: ['*'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'stage-match', rule: 'Copy language must match the target awareness stage', kind: 'must_have' },
    { id: 'no-mix', rule: 'Single piece should not mix multiple stages', kind: 'must_avoid' },
  ],
  manipulation_risk: 2,
  STAGES,
  STAGE_SIGNALS,
  OPENER_TEMPLATES,
  detectStage,
  applyToDraft,
  generateFromSpec,
};
