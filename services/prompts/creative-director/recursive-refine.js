'use strict';

/**
 * Recursive self-assessment + brief compliance (smixs/creative-director-skill Phase 4).
 * Gap analysis and stopping criteria live in scoring.js — not duplicated here.
 */

const BRIEF_COMPLIANCE_8 = `
## Brief compliance (pass/fail — any fail = do not present)

1. Is there an idea? (one sentence)
2. Does it convey the intended message?
3. Does it respond to the insight?
4. Does it suit the target audience?
5. Are mandatory elements included?
6. Legislation / ethics OK?
7. Brand voice preserved?
8. Supported by real product attributes?
`.trim();

function smbStoppingLine(ideaLevel) {
  const lvl = String(ideaLevel || 'campaign').toLowerCase();
  if (lvl === 'brand' || lvl === 'advertising' || lvl === 'business') {
    return 'Success: weighted ≥ 8.5 AND HumanKind ≥ 7 (stretch 9+ only with named canon + pre-mortem).';
  }
  return 'Success: weighted ≥ 8.0 AND HumanKind ≥ 6 (SMB daily content — do not chase Cannes 9+ unless brief is brand-level).';
}

function buildRecursiveRefineSection(ideaLevel = 'campaign') {
  return [
    BRIEF_COMPLIANCE_8,
    '',
    '## Recursive refine cycle (Phase 4)',
    '',
    'PASS 0 — Idea level matches Pollard requirement from intake.',
    'PASS 1 — Brief compliance (8 questions above), then apply the scoring block above (six criteria + HumanKind + Grey + gap analysis).',
    'PASS 2–3 — Refine (max 3 passes total in this call):',
    '  - If below stopping criteria: gap-diagnose using the GAP ANALYSIS RULES in the scoring section.',
    '  - Apply a DIFFERENT method from the triad (not the one that produced the weak idea).',
    '  - Pre-mortem before presenting the final concept.',
    '',
    `Stopping for this brief (${ideaLevel}): ${smbStoppingLine(ideaLevel)}`,
    '  - Plateau: 2 consecutive passes with weighted delta < 0.2 → ship best with honest note in rationale.',
    '  - Hard stop: 3 refinement passes completed → deliver best with honest assessment.',
  ].join('\n');
}

module.exports = {
  BRIEF_COMPLIANCE_8,
  buildRecursiveRefineSection,
  smbStoppingLine,
};
