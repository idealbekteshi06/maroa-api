'use strict';

/**
 * Sugarman's 30 Psychological Triggers.
 *
 * Source: Joseph Sugarman, "The Adweek Copywriting Handbook" (2007).
 *
 * 30 triggers that move a prospect from indifference to purchase. Most
 * pieces of copy use 3–5 of them deliberately. The framework helps a
 * model think about WHICH triggers fit WHICH stage / audience instead of
 * pulling random emotional levers.
 *
 * Manipulation_risk = 5 (medium-high). Several triggers — fear, greed,
 * urgency — tip into manipulation if stacked. The applyToDraft check
 * flags excessive stacking.
 */

const { _normalize, _containsAny, makeFix, applicability } = require('../_helpers');

/**
 * The 30 triggers, each with: id, name, language markers that indicate
 * its use, manipulation_risk for that specific trigger, when to use it.
 */
const TRIGGERS = Object.freeze([
  // Logical / informative triggers (low risk)
  {
    id: 'authority',
    name: 'Authority',
    markers: ['expert', 'professor', 'doctor', 'phd', 'years of experience', 'specialist'],
    risk: 1,
    when: 'When credentials genuinely matter to the decision',
  },
  {
    id: 'consistency',
    name: 'Consistency',
    markers: ['since you', 'as someone who', 'committed to', 'in line with'],
    risk: 1,
    when: 'When the prospect has already taken a small action',
  },
  {
    id: 'specifics',
    name: 'Specifics',
    markers: [/\b\d+%\b/, /\$\d+/, /\b\d{2,}\b/],
    risk: 1,
    when: 'Always — specifics beat generalities',
  },
  {
    id: 'familiarity',
    name: 'Familiarity',
    markers: ['you know', 'remember when', 'we all', 'most of us'],
    risk: 1,
    when: 'Establishing common ground',
  },
  {
    id: 'storytelling',
    name: 'Storytelling',
    markers: ['once', 'one day', 'a customer told us', 'i used to'],
    risk: 1,
    when: 'For emotional payload that bypasses skepticism',
  },
  {
    id: 'simplicity',
    name: 'Simplicity',
    markers: ['simple', 'in one step', 'just', 'easy', '3 steps'],
    risk: 1,
    when: 'Complex offers benefit from "made it simple" framing',
  },
  {
    id: 'curiosity',
    name: 'Curiosity',
    markers: ['secret', 'discover', 'what no one tells', 'truth about', 'why'],
    risk: 2,
    when: 'TOFU especially — opens the loop',
  },
  {
    id: 'honesty',
    name: 'Honesty',
    markers: ['the truth is', "i'll admit", "we don't", 'not for everyone'],
    risk: 1,
    when: 'Disqualifying weak fits / building trust',
  },
  {
    id: 'mental-engagement',
    name: 'Mental engagement',
    markers: ['imagine', 'picture this', 'what if'],
    risk: 2,
    when: 'Bringing the reader into the experience',
  },
  {
    id: 'satisfaction-conviction',
    name: 'Satisfaction conviction (guarantee)',
    markers: ['guarantee', 'money back', 'risk-free', "we'll refund"],
    risk: 1,
    when: 'Risk reversal — almost always positive',
  },

  // Social / emotional triggers (medium risk)
  {
    id: 'social-proof',
    name: 'Social proof',
    markers: ['customers', 'reviews', 'rated', '★', 'used by', 'thousands of'],
    risk: 2,
    when: 'You actually have the proof — never fake',
  },
  {
    id: 'belonging',
    name: 'Belonging',
    markers: ['join', 'community', 'thousands like you', 'one of us'],
    risk: 3,
    when: 'Identity-driven products',
  },
  {
    id: 'desire-to-collect',
    name: 'Desire to collect',
    markers: ['limited edition', 'collector', 'series', 'complete the set'],
    risk: 4,
    when: 'Premium / collectible categories only',
  },
  {
    id: 'hope',
    name: 'Hope',
    markers: ['finally', 'imagine being', 'a better', 'transform'],
    risk: 3,
    when: 'Aspirational products — but back it up',
  },
  {
    id: 'love',
    name: 'Love',
    markers: ['for your family', 'someone you love', 'take care of'],
    risk: 4,
    when: 'Gift / care categories only',
  },
  {
    id: 'pride-of-ownership',
    name: 'Pride of ownership',
    markers: ['craftsmanship', 'made by', 'limited', 'exclusive'],
    risk: 3,
    when: 'Premium / lifestyle products',
  },
  {
    id: 'nostalgia',
    name: 'Nostalgia',
    markers: ['remember when', 'like it used to be', 'classic', 'old-school'],
    risk: 3,
    when: 'Genuine heritage products',
  },
  {
    id: 'sense-of-urgency',
    name: 'Sense of urgency',
    markers: ['today', 'now', 'before', 'ends', 'last chance', 'while supplies last'],
    risk: 5,
    when: 'Only with REAL deadlines',
  },

  // Greed / fear triggers (high risk — use sparingly)
  {
    id: 'fear',
    name: 'Fear',
    markers: ['miss out', 'fall behind', 'risk losing', "don't let", "before it's too late"],
    risk: 7,
    when: 'Real risk being communicated — never invented',
  },
  {
    id: 'greed',
    name: 'Greed',
    markers: ['save', 'profit', '10x', 'double your', 'earn more'],
    risk: 6,
    when: 'When the financial outcome is real + earned',
  },
  {
    id: 'scarcity',
    name: 'Scarcity',
    markers: ['only', 'limited to', 'last', 'only X left', 'sold out soon'],
    risk: 6,
    when: 'Only with REAL supply constraint',
  },
  {
    id: 'exclusivity',
    name: 'Exclusivity',
    markers: ['invitation only', 'members only', 'select', 'private'],
    risk: 5,
    when: 'Real gating exists',
  },

  // Cognitive triggers (low-medium)
  {
    id: 'guilt',
    name: 'Guilt',
    markers: ['you owe yourself', "after everything you've", "haven't you"],
    risk: 7,
    when: 'AVOID in most cases — high manipulation',
  },
  {
    id: 'sense-of-touch',
    name: 'Sense of touch',
    markers: ['feel', 'soft', 'smooth', 'in your hand'],
    risk: 1,
    when: 'Physical products',
  },
  {
    id: 'integrity',
    name: 'Integrity',
    markers: ['we believe', 'our mission', 'we stand for', 'no compromises'],
    risk: 2,
    when: 'Real values backed by action',
  },
  {
    id: 'reciprocity',
    name: 'Reciprocity',
    markers: ['free', 'on us', 'no obligation', 'our gift to you'],
    risk: 3,
    when: 'Genuine value being offered first',
  },
  {
    id: 'linking',
    name: 'Linking',
    markers: ['like you said', 'building on', 'next step'],
    risk: 2,
    when: 'Following a prior touchpoint',
  },
  {
    id: 'product-involvement',
    name: 'Product involvement',
    markers: ['try', 'test', 'customize', 'choose your'],
    risk: 2,
    when: 'Interactive products',
  },
  {
    id: 'value-and-worth',
    name: 'Value and worth',
    markers: ['worth', 'value', '$X retail', 'priced at'],
    risk: 3,
    when: 'When real comparison value exists',
  },
  {
    id: 'desire-to-belong-to-a-tribe',
    name: 'Tribe identity',
    markers: ['for makers', 'founders', 'creators', 'people like you'],
    risk: 3,
    when: 'Identity products / community brands',
  },
]);

const TRIGGERS_BY_ID = Object.fromEntries(TRIGGERS.map((t) => [t.id, t]));

function detectTriggers(draft) {
  if (!draft || typeof draft !== 'string') return [];
  const used = [];
  for (const t of TRIGGERS) {
    if (_containsAny(draft, t.markers)) used.push({ id: t.id, name: t.name, risk: t.risk });
  }
  return used;
}

function applyToDraft(draft, context = {}) {
  if (!draft || typeof draft !== 'string') {
    return { score: 0, fixes: [], reasoning: 'empty draft' };
  }
  const used = detectTriggers(draft);
  const fixes = [];

  // Excellence: 3-5 triggers is the sweet spot
  if (used.length < 1) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Sugarman: no recognizable triggers detected — copy reads flat',
        suggestion: 'Add 3–5 deliberate triggers (specifics, curiosity, social proof, simplicity, hope).',
      })
    );
  } else if (used.length > 7) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: `Sugarman: ${used.length} triggers detected — likely over-stacked`,
        suggestion: 'Pick the 3–5 strongest triggers for this stage. Stacking reduces credibility.',
      })
    );
  }

  // Manipulation ceiling: total trigger risk > 18 = uncomfortable territory
  const totalRisk = used.reduce((sum, t) => sum + (t.risk || 0), 0);
  if (totalRisk > 18) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: `Sugarman: stacked manipulation triggers (total risk ${totalRisk})`,
        suggestion: 'Drop the heaviest triggers (fear, guilt, fake scarcity). Replace with proof or specifics.',
      })
    );
  }

  // Score = sweet-spot fit (3-5 triggers, total risk under 18)
  const inSweetSpot = used.length >= 3 && used.length <= 5;
  const underRiskCap = totalRisk <= 18;
  const score = inSweetSpot && underRiskCap ? 1.0 : inSweetSpot ? 0.6 : underRiskCap ? 0.5 : 0.2;

  return {
    score,
    fixes,
    reasoning: `triggers=${used.length} (${used.map((u) => u.id).join(',')}) totalRisk=${totalRisk}`,
  };
}

function generateFromSpec({ awareness_stage, audience, product, recommended_triggers } = {}) {
  // If caller specified triggers, use them. Otherwise pick safe defaults
  // by stage.
  const stage = awareness_stage || 'problem_aware';
  let triggers = recommended_triggers;
  if (!triggers || !triggers.length) {
    const SAFE_DEFAULTS_BY_STAGE = {
      unaware: ['storytelling', 'curiosity', 'specifics'],
      problem_aware: ['specifics', 'social-proof', 'hope'],
      solution_aware: ['authority', 'specifics', 'satisfaction-conviction'],
      product_aware: ['social-proof', 'specifics', 'sense-of-urgency'],
      most_aware: ['specifics', 'sense-of-urgency'],
    };
    triggers = SAFE_DEFAULTS_BY_STAGE[stage] || ['specifics', 'social-proof', 'simplicity'];
  }
  return {
    structure: `Sugarman triggers: ${triggers.join(', ')}`,
    prompt_segments: [
      `Apply ${triggers.length} psychological triggers deliberately:`,
      ...triggers.map((id) => {
        const t = TRIGGERS_BY_ID[id];
        return t ? `  • ${t.name}: ${t.when}` : `  • ${id}`;
      }),
      `Audience: ${audience || 'the customer'}. Product: ${product || 'the offer'}.`,
      'Stack triggers in service of the message — not as a checklist. 3–5 is the sweet spot.',
    ],
  };
}

module.exports = {
  id: 'sugarman-30-triggers',
  name: "Sugarman's 30 Psychological Triggers",
  category: 'psychology',
  source_citation: 'Joseph Sugarman, "The Adweek Copywriting Handbook" (2007)',
  applicability: applicability({
    awareness_stages: ['*'],
    funnel_stages: ['*'],
    channels: ['*'],
    industries: ['*'],
    regions: ['*'],
  }),
  invariants: [
    { id: 'sweet-spot', rule: '3–5 triggers per piece — not 1, not 10', kind: 'must_have' },
    { id: 'risk-cap', rule: 'Total trigger manipulation_risk ≤ 18', kind: 'must_avoid' },
  ],
  manipulation_risk: 5,
  TRIGGERS,
  TRIGGERS_BY_ID,
  detectTriggers,
  applyToDraft,
  generateFromSpec,
};
