'use strict';

/**
 * StoryBrand SB7 — Donald Miller, "Building a StoryBrand" (2017).
 *
 * Cast the CUSTOMER as the hero, the BRAND as the guide. Brands that
 * try to be the hero confuse customers and depress conversion.
 *
 * The 7 elements:
 *   1. CHARACTER — the customer (not the brand) is the hero
 *   2. PROBLEM   — external + internal + philosophical pain
 *   3. GUIDE     — the brand shows up as helper with empathy + authority
 *   4. PLAN      — clear, simple steps (3-step processes work best)
 *   5. CALL TO ACTION — direct (primary) + transitional (free first)
 *   6. SUCCESS — paint the resolved life
 *   7. FAILURE — name what's at stake if they don't act
 *
 * Manipulation_risk = 2 (low). The framework specifically REJECTS heroic
 * brand-as-savior framing, which keeps the model honest.
 */

const { _normalize, _containsAny, makeFix, applicability } = require('../_helpers');

const HERO_FOCUS_MARKERS = ['you ', 'your ', "you're ", "you'll ", 'help you'];
const BRAND_HERO_RED_FLAGS = [
  // "We're amazing" framing — StoryBrand rejects this
  'we are the leader',
  'we are the best',
  'our award-winning',
  'we are #1',
  'industry-leading us',
  'best in class us',
  'we revolutionize',
  'we deliver',
  'we are committed to',
];
const GUIDE_MARKERS = [
  // "We help you" / empathy + authority
  'we help you',
  'we work with',
  'after working with',
  'after helping',
  'we understand',
  'we know',
  'we built this for',
];
const PLAN_MARKERS = [
  // Step language — 3-step plans test best
  /\bstep 1\b/i,
  /\bstep one\b/i,
  /\b1\. /,
  /\bfirst,/i,
  "here's how",
  'three steps',
  '3 steps',
  'simple plan',
];
const SUCCESS_MARKERS = ['imagine', 'finally', 'wake up to', 'enjoy', 'love how', 'see results'];
const FAILURE_MARKERS = ['without', 'still', 'instead of', "before it's too late", "don't miss", 'lose', 'fall behind'];

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }
  const fixes = [];

  // CHARACTER — "you" must dominate over "we"
  const youCount = (draft.match(/\byou\b/gi) || []).length;
  const weCount = (draft.match(/\bwe\b/gi) || []).length;
  const customerIsHero = youCount >= weCount;
  if (!customerIsHero) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'SB7-Character: brand dominates over customer ("we" beats "you")',
        suggestion: 'Rewrite from the customer\'s point of view. "You" should appear more than "we".',
      })
    );
  }

  // BRAND-AS-HERO violation — explicit anti-pattern
  if (_containsAny(draft, BRAND_HERO_RED_FLAGS)) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'SB7: brand is positioned as hero instead of guide',
        suggestion: 'Strip "we are the leader / best / #1" language. Position the customer as the hero.',
      })
    );
  }

  // GUIDE — brand should show empathy + authority
  const hasGuide = _containsAny(draft, GUIDE_MARKERS);

  // PLAN — clear next steps
  const hasPlan = _containsAny(draft, PLAN_MARKERS) || /3\s*(step|easy|simple)/i.test(draft);

  // CALL TO ACTION — must have an action verb in the closing
  const hasCta = /\b(get|start|book|try|schedule|order|sign up|join|claim)\b/i.test(
    draft.slice(Math.floor(draft.length * 0.6))
  );
  if (!hasCta) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'SB7-CTA: no clear call to action in the final third',
        suggestion:
          'Add a direct CTA ("Book a call", "Start free") + optionally a transitional one ("Read the guide").',
      })
    );
  }

  // SUCCESS / FAILURE — at least one of "what life looks like after" OR
  // "what's at stake if they don't" should appear
  const hasSuccess = _containsAny(draft, SUCCESS_MARKERS);
  const hasFailure = _containsAny(draft, FAILURE_MARKERS);
  if (!hasSuccess && !hasFailure) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'SB7: missing success picture AND failure stake — copy feels flat',
        suggestion: "Paint at least one: the resolved life (success) or what they'll regret (failure).",
      })
    );
  }

  // Score
  const present = [
    customerIsHero,
    !_containsAny(draft, BRAND_HERO_RED_FLAGS),
    hasGuide,
    hasPlan,
    hasCta,
    hasSuccess || hasFailure,
  ].filter(Boolean).length;
  const score = present / 6;

  return {
    score,
    fixes,
    reasoning: `SB7 elements present: ${present}/6`,
  };
}

function generateFromSpec({ product, audience, painPoint, outcome, plan_steps = ['Step 1', 'Step 2', 'Step 3'] } = {}) {
  return {
    structure: 'Character → Problem → Guide → Plan → CTA → Success / Failure',
    prompt_segments: [
      `CHARACTER: cast ${audience || 'the customer'} as the hero. Use "you", not "we".`,
      `PROBLEM: name the external pain (what's broken), internal pain (how it feels), and philosophical pain (why it's unjust). Focus on ${painPoint || 'their top frustration'}.`,
      `GUIDE: show empathy first ("we get it"), then authority ("here's what we've learned"). DO NOT claim "we are the leader / best / #1".`,
      `PLAN: present a clear ${plan_steps.length}-step path: ${plan_steps.join(' → ')}. The simpler the plan, the higher the conversion.`,
      `CTA: one direct CTA ("Book a call") + one transitional ("Read the guide first") so risk-averse customers have a low-friction option.`,
      `SUCCESS: paint the resolved life — ${outcome || 'where they end up'}. Make it concrete and visual.`,
      `FAILURE: briefly name what continues without ${product || 'the solution'} — but stay grounded, not catastrophic.`,
    ],
  };
}

module.exports = {
  id: 'storybrand',
  name: 'StoryBrand SB7',
  category: 'structural',
  source_citation: 'Donald Miller, "Building a StoryBrand" (2017)',
  applicability: applicability({
    awareness_stages: ['problem_aware', 'solution_aware', 'product_aware'],
    funnel_stages: ['mofu', 'bofu'],
    channels: ['landing-page-hero', 'landing-page-long', 'sales-page', 'email-nurture', 'about-page'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'character', rule: '"You" must appear more than "we"', kind: 'must_have' },
    { id: 'not-hero', rule: 'Brand must NOT position itself as the leader/best/#1', kind: 'must_avoid' },
    { id: 'plan', rule: 'Must include a clear 3-step plan or equivalent', kind: 'must_have' },
    { id: 'cta', rule: 'Must include a direct CTA in the final third', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
