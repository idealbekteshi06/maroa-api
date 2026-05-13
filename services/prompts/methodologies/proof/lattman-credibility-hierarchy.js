'use strict';

/**
 * Lattman Credibility Hierarchy — cite-first, claim-second.
 *
 * Source: Steven Lattman + general academic-writing best practice
 * adapted to marketing. The principle: when making a claim, lead with
 * the source of the claim, not the claim itself.
 *
 * "Harvard found 73% of users save 4 hours/week" beats
 * "Users save 4 hours/week (Harvard study, link)" — because the
 * second risks being skimmed before the citation lands.
 *
 * Manipulation_risk = 1.
 */

const { makeFix, applicability } = require('../_helpers');

const SOURCE_LEAD_PATTERNS = [
  /^(harvard|stanford|mit|nature|the lancet|wall street journal|new york times|forbes)/i,
  /\b(according to|study by|research from|published in|study published)/i,
];

function applyToDraft(draft) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const hasNumberClaim = /\d+%|\d+ out of \d+|\bover \d+/i.test(draft);
  if (!hasNumberClaim) return { score: 0.5, fixes: [], reasoning: 'no statistical claim to check' };
  // If there's a number claim, is it preceded by a source?
  const sourceFirst = SOURCE_LEAD_PATTERNS.some((p) => p.test(draft));
  const fixes = [];
  if (!sourceFirst) {
    fixes.push(
      makeFix({
        severity: 'suggest',
        issue: 'Lattman: statistical claim without preceding source',
        suggestion: 'Lead with the source ("Harvard found...") so credibility lands before the number.',
      })
    );
  }
  return { score: sourceFirst ? 1.0 : 0.4, fixes, reasoning: `source-first=${sourceFirst}` };
}

function generateFromSpec({ source, claim }) {
  return {
    structure: 'Source → Claim',
    prompt_segments: [
      `When citing a statistic, format: "${source || '[institution / publication]'} found ${claim || '[specific number]'}." — source first.`,
      'For internal data: "Our customers report X" — name the source.',
    ],
  };
}

module.exports = {
  id: 'lattman-credibility-hierarchy',
  name: 'Lattman Credibility Hierarchy',
  category: 'proof',
  source_citation: 'Adapted from academic writing best practice',
  applicability: applicability({
    funnel_stages: ['mofu', 'bofu'],
    channels: ['landing-page-long', 'sales-page', 'blog-thought-leadership'],
  }),
  invariants: [{ id: 'source-first', rule: 'Statistical claims should be source-led', kind: 'must_have' }],
  manipulation_risk: 1,
  applyToDraft,
  generateFromSpec,
};
