'use strict';

/**
 * PAS — Problem, Agitate, Solve.
 *
 * The direct-response classic. Name the customer's pain, twist the knife
 * (agitate), then offer the cure (solve).
 *
 * Source: rooted in 1920s direct-mail copy (Hopkins, Halbert). The PAS
 * acronym was popularized by Dan Kennedy in the 1990s ("No B.S. Direct
 * Marketing"). Used relentlessly by Gary Halbert + every DR copywriter
 * since.
 *
 * Power: PAS works because attention naturally orients toward pain
 * before benefit (Kahneman's loss aversion). The agitation step is
 * what makes the eventual relief feel earned.
 *
 * Manipulation_risk = 4 (medium). The "agitate" step can tip into fear-
 * mongering or shame if overdone. Modern responsible PAS keeps agitation
 * grounded in real, observable customer experience — not invented dread.
 */

const { _normalize, _sentences, _containsAny, _wordCount, makeFix, applicability } = require('../_helpers');

const PROBLEM_MARKERS = [
  // Cues that the copy is naming a pain
  'tired of',
  'sick of',
  'frustrated',
  'struggle',
  'struggling',
  "can't",
  'unable to',
  'failed',
  'wasting',
  'losing',
  'missed',
  'no time',
  'no idea',
  'overwhelmed',
  'stuck',
  'fall short',
  'every time you',
  'why does',
  'how many times have you',
];

const AGITATE_MARKERS = [
  // Twist-the-knife language
  'imagine',
  'meanwhile',
  'every day',
  'every week',
  'still',
  'yet again',
  'worst part',
  'and it gets worse',
  'before you know it',
  'the truth is',
  'while you',
  'instead',
  'after all that',
  'and then',
  'now imagine',
  'until one day',
  'what no one tells you',
  'the reality is',
];

const SOLVE_MARKERS = [
  // Resolution / cure language
  'now',
  'finally',
  'introducing',
  'meet',
  "here's the thing",
  'enter',
  "that's where",
  'imagine if',
  'what if',
  'with',
  'we built',
  'this is why',
  'so we made',
  'thanks to',
  'because of',
];

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }

  const sentences = _sentences(draft);
  const fixes = [];

  // PAS requires order: problem first, agitate middle, solve last.
  const total = draft.length;
  const firstThird = draft.slice(0, Math.floor(total / 3));
  const middleThird = draft.slice(Math.floor(total / 3), Math.floor((total * 2) / 3));
  const lastThird = draft.slice(Math.floor((total * 2) / 3));

  const hasProblem = _containsAny(firstThird, PROBLEM_MARKERS);
  const hasAgitate = _containsAny(middleThird, AGITATE_MARKERS) || _containsAny(draft, AGITATE_MARKERS);
  const hasSolve = _containsAny(lastThird, SOLVE_MARKERS);

  if (!hasProblem) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'PAS-P: opening does not name a customer pain',
        suggestion: 'Open by stating a specific frustration the reader recognizes ("Tired of X?").',
      })
    );
  }
  if (!hasAgitate) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'PAS-A: pain is named but not agitated — reader may not feel the cost',
        suggestion: 'Add one sentence amplifying what continued pain costs them (time, money, embarrassment).',
      })
    );
  }
  if (!hasSolve) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'PAS-S: no resolution / solution presented',
        suggestion: 'End by introducing the cure and the path to it.',
      })
    );
  }

  // Ethics check: agitation should be grounded, not invented dread.
  // Heuristic: if the draft contains catastrophizing words but no
  // specific customer-experience anchor, flag it.
  const catastrophizing = /\b(destroy|ruin|disaster|collapse|crisis|nightmare|catastrophe)\b/i.test(draft);
  const groundedInExperience = /\b(every day|when you|the moment|right now|customers tell us|users say)\b/i.test(draft);
  if (catastrophizing && !groundedInExperience) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'PAS ethics: catastrophizing without grounded customer experience',
        suggestion: "Replace abstract dread with a specific, observable moment from your customers' lives.",
      })
    );
  }

  const stagesPresent = [hasProblem, hasAgitate, hasSolve].filter(Boolean).length;
  const score = stagesPresent / 3;

  return {
    score,
    fixes,
    reasoning: `PAS stages: P:${hasProblem} A:${hasAgitate} S:${hasSolve}`,
  };
}

function generateFromSpec({ product, audience, painPoint, outcome } = {}) {
  return {
    structure: 'Problem → Agitate → Solve',
    prompt_segments: [
      `PROBLEM: open with a specific, recognizable pain — ${painPoint || "the customer's top frustration"} — as the customer would describe it themselves.`,
      `AGITATE: amplify the cost of leaving this unresolved. What does this pain look like every day for ${audience || 'them'}? Stay grounded in real customer experience, not invented dread.`,
      `SOLVE: introduce ${product || 'the solution'} as the path from pain to ${outcome || 'the desired outcome'}. One concrete next step.`,
    ],
  };
}

module.exports = {
  id: 'pas',
  name: 'PAS — Problem, Agitate, Solve',
  category: 'structural',
  source_citation: 'Dan Kennedy, "No B.S. Direct Marketing" (1996); rooted in Hopkins/Halbert DR tradition',
  applicability: applicability({
    awareness_stages: ['problem_aware', 'solution_aware'],
    funnel_stages: ['tofu', 'mofu', 'bofu'],
    channels: ['email-cold', 'email-promo', 'meta-ads-video', 'sales-page', 'landing-page-long'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'P', rule: 'Must name a specific customer pain in the first third', kind: 'must_have' },
    { id: 'A', rule: 'Must amplify cost of inaction', kind: 'must_have' },
    { id: 'S', rule: 'Must present the solution in the final third', kind: 'must_have' },
    {
      id: 'ethics',
      rule: 'Agitation must be grounded in real customer experience, not invented dread',
      kind: 'must_avoid',
    },
  ],
  manipulation_risk: 4,
  applyToDraft,
  generateFromSpec,
};
