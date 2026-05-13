'use strict';

/**
 * Star, Story, Solution.
 *
 * Source: Gary Halbert variant of classic DR structures (Halbert
 * Newsletter archives, 1986+). Open with a "star" (the protagonist or
 * the central character — could be a customer, product, or idea), tell
 * their story, then reveal the solution that resolves it.
 *
 * Manipulation_risk = 2. Narrative-first; relies on attention, not pressure.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const STAR_MARKERS = ['meet', 'this is', 'introducing', 'my name is', 'one of our customers', 'sarah', 'marcus'];
const STORY_MARKERS = ['then', 'one day', 'until', 'years later', 'after', 'a few months ago'];
const SOLUTION_MARKERS = ["that's when", 'turns out', 'we built', 'the answer was', "here's what worked"];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const s = _containsAny(draft, STAR_MARKERS);
  const t = _containsAny(draft, STORY_MARKERS);
  const sol = _containsAny(draft, SOLUTION_MARKERS);
  const fixes = [];
  if (!s)
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Star,Story,Solution: no clear protagonist',
        suggestion: 'Open by introducing someone the reader can identify with.',
      })
    );
  const present = [s, t, sol].filter(Boolean).length;
  return { score: present / 3, fixes, reasoning: `S/S/S: ${present}/3` };
}

function generateFromSpec({ character, journey, resolution }) {
  return {
    structure: 'Star → Story → Solution',
    prompt_segments: [
      `STAR: introduce ${character || 'a recognizable protagonist'} the reader will see themselves in.`,
      `STORY: tell ${journey || 'their journey'} with specific moments — not a summary.`,
      `SOLUTION: reveal ${resolution || 'the resolution'} as the natural answer to the story.`,
    ],
  };
}

module.exports = {
  id: 'star-story-solution',
  name: 'Star, Story, Solution (Halbert variant)',
  category: 'structural',
  source_citation: 'Gary Halbert Newsletter archives (1986+)',
  applicability: applicability({
    funnel_stages: ['tofu', 'mofu'],
    channels: ['email-cold', 'email-nurture', 'sales-page'],
  }),
  invariants: [{ id: 'star', rule: 'Must introduce a protagonist', kind: 'must_have' }],
  manipulation_risk: 2,
  applyToDraft,
  generateFromSpec,
};
