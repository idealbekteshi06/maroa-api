'use strict';

/**
 * Cialdini's 7 Principles of Persuasion.
 *
 * Source: Robert Cialdini, "Influence" (1984, revised 2021 to add #7).
 *
 * The canonical persuasion taxonomy. Reciprocity, Commitment & Consistency,
 * Social Proof, Authority, Liking, Scarcity, and Unity (added 2021).
 *
 * Cialdini's own warning ("the ethics question"): these principles can be
 * used for influence OR manipulation. The difference is whether you're
 * pointing to TRUE features of the situation, or fabricating them.
 *
 * Manipulation_risk = 6. The principles are powerful; misuse is easy.
 * The applyToDraft check flags scarcity-without-real-constraint and
 * authority-without-credentials.
 */

const { _containsAny, makeFix, applicability } = require('../_helpers');

const PRINCIPLES = Object.freeze([
  {
    id: 'reciprocity',
    name: 'Reciprocity',
    markers: ['free', 'gift', 'on us', 'no obligation', 'complimentary'],
    risk: 3,
  },
  {
    id: 'commitment',
    name: 'Commitment & Consistency',
    markers: ['as someone who', 'since you', 'committed to', 'you said'],
    risk: 3,
  },
  {
    id: 'social-proof',
    name: 'Social Proof',
    markers: ['customers', 'reviews', '★', 'rated', 'used by', /\d{2,}\+ /],
    risk: 2,
  },
  {
    id: 'authority',
    name: 'Authority',
    markers: ['phd', 'professor', 'expert', 'years of experience', 'certified', 'specialist'],
    risk: 3,
  },
  { id: 'liking', name: 'Liking', markers: ['like you', 'we get it', 'just like you', 'people like us'], risk: 3 },
  {
    id: 'scarcity',
    name: 'Scarcity',
    markers: ['only', 'limited', 'last', 'while supplies', 'ends', 'closing'],
    risk: 6,
  },
  { id: 'unity', name: 'Unity (added 2021)', markers: ['us', 'our community', 'we believe', 'people who'], risk: 3 },
]);

function detectPrinciples(draft) {
  if (!draft) return [];
  return PRINCIPLES.filter((p) => _containsAny(draft, p.markers)).map((p) => ({ id: p.id, risk: p.risk }));
}

function applyToDraft(draft, context = {}) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const used = detectPrinciples(draft);
  const fixes = [];

  // Scarcity-without-real-constraint is the most-flagged Cialdini abuse
  const hasScarcity = used.some((p) => p.id === 'scarcity');
  const hasRealConstraint = /\b(only \d+|\d+ left|ends \w+ \d|until \w+ \d|sold out)\b/i.test(draft);
  if (hasScarcity && !hasRealConstraint) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: 'Cialdini ethics: scarcity language without real constraint',
        suggestion:
          'Either name the actual limit ("only 40 spots", "ends Tuesday at midnight") or remove the scarcity language.',
      })
    );
  }

  // Authority claims without credentials
  const hasAuthority = used.some((p) => p.id === 'authority');
  const hasCredentials = /\b(phd|md|cpa|esq|cfa|certified by|licensed in|\d+ years)\b/i.test(draft);
  if (hasAuthority && !hasCredentials) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Cialdini ethics: authority signal without specific credentials',
        suggestion: 'Pair authority claims with concrete credentials (years, certifications, named publications).',
      })
    );
  }

  // Total risk ceiling
  const totalRisk = used.reduce((s, p) => s + p.risk, 0);
  if (totalRisk > 15) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: `Cialdini: stacked manipulation principles (total risk ${totalRisk})`,
        suggestion: 'Drop the highest-risk principles (scarcity, authority) and keep proof + reciprocity.',
      })
    );
  }

  const score = used.length === 0 ? 0.3 : used.length >= 2 && totalRisk <= 12 ? 1.0 : 0.6;
  return {
    score,
    fixes,
    reasoning: `principles=${used.map((u) => u.id).join(',')} risk=${totalRisk}`,
  };
}

function generateFromSpec({ awareness_stage, principles = ['social-proof', 'authority', 'reciprocity'] }) {
  return {
    structure: `Cialdini principles: ${principles.join(', ')}`,
    prompt_segments: [
      `Apply 2-3 Cialdini principles deliberately: ${principles.join(', ')}.`,
      'For scarcity: only when a REAL constraint exists. For authority: name specific credentials. Never invent either.',
      'Avoid stacking 4+ principles — credibility drops.',
    ],
  };
}

module.exports = {
  id: 'cialdini-7',
  name: 'Cialdini 7 Principles of Persuasion',
  category: 'psychology',
  source_citation: 'Robert Cialdini, "Influence" (1984, revised 2021)',
  applicability: applicability({}),
  invariants: [
    { id: 'real-scarcity', rule: 'Scarcity language requires real constraint', kind: 'must_avoid' },
    { id: 'real-authority', rule: 'Authority claims require specific credentials', kind: 'must_have' },
  ],
  manipulation_risk: 6,
  PRINCIPLES,
  detectPrinciples,
  applyToDraft,
  generateFromSpec,
};
