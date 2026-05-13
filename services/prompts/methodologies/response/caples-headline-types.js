'use strict';

/**
 * Caples Headline Types — 7 proven headline categories.
 *
 * Source: John Caples, "Tested Advertising Methods" (1932, revised 1997).
 * Caples ran more split tests in DR than anyone of his era; his book is
 * still the canonical headline reference.
 *
 * The 7 types:
 *   1. NEWS         — "Introducing X" / "Now you can..."
 *   2. HOW-TO       — "How to X in Y minutes"
 *   3. WHY          — "Why X..."
 *   4. QUESTION     — "Do you make these X mistakes?"
 *   5. COMMAND      — "Stop doing X" / "Get Y now"
 *   6. TESTIMONIAL  — Quote from a real customer
 *   7. "IF YOU"     — "If you X, you can Y"
 *
 * Caples's rule: most ads need to test all 7 to find the one that works.
 * The system can pre-pick based on stage (Why+How-to work TOFU; Command
 * and Testimonial work BOFU).
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const TYPE_PATTERNS = {
  news: [/^(introducing|now you can|the new|announcing)/i],
  'how-to': [/^how to /i],
  why: [/^why /i],
  question: [/\?$/],
  command: [/^(stop|get|start|try|join|order|buy|claim)\b/i],
  testimonial: [/^["'][\s\S]+["']/, /^—\s*[A-Z]/],
  'if-you': [/^if you /i],
};

function detectType(headline) {
  if (!headline) return null;
  for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(headline)) return type;
    }
  }
  return null;
}

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const firstLine = draft.split('\n')[0].trim();
  const type = detectType(firstLine);
  const fixes = [];
  if (!type) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: "Caples: headline doesn't match any of the 7 proven types",
        suggestion: 'Try News, How-to, Why, Question, Command, Testimonial, or "If you" patterns.',
      })
    );
  }
  return { score: type ? 1.0 : 0.4, fixes, reasoning: `headline_type=${type || 'none'}` };
}

function generateFromSpec({ awareness_stage, audience }) {
  const recommended =
    awareness_stage === 'unaware' || awareness_stage === 'problem_aware'
      ? ['why', 'how-to', 'question']
      : awareness_stage === 'most_aware'
        ? ['command', 'testimonial']
        : ['news', 'how-to'];
  return {
    structure: `Caples headline type (recommended for ${awareness_stage || 'this stage'}): ${recommended.join(' / ')}`,
    prompt_segments: [
      `Write the headline as one of: ${recommended.join(', ')}.`,
      `Audience: ${audience || 'the customer'}. Use their language, not yours.`,
    ],
  };
}

module.exports = {
  id: 'caples-headline-types',
  name: 'Caples 7 Headline Types',
  category: 'response',
  source_citation: 'John Caples, "Tested Advertising Methods" (1932, rev. 1997)',
  applicability: applicability({}),
  invariants: [{ id: 'recognizable-type', rule: 'Headline should match a proven type', kind: 'must_have' }],
  manipulation_risk: 2,
  TYPE_PATTERNS,
  detectType,
  applyToDraft,
  generateFromSpec,
};
