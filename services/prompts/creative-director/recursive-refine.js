'use strict';

/**
 * Recursive self-assessment + brief compliance (smixs/creative-director-skill Phase 4).
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

const RECURSIVE_REFINE_ALGORITHM = `
## Recursive refine cycle (Phase 4)

PASS 0 — Idea level matches Pollard requirement from intake.
PASS 1 — Three-axis evaluation:
  - Axis 1: Brief compliance (8 questions above)
  - Axis 2: Six weighted criteria + HumanKind + Grey scales
  - Axis 3: Pattern saturation (P01-P18) — cap originality if saturated

PASS 2 — Gap diagnosis:
  - Weighted ≥ 8 + HumanKind < 7 → clever but doesn't matter
  - Weighted < 7 + HumanKind ≥ 8 → matters but boring
  - Both ≥ 8 → polish scalability
  - Both < 7 → restart with different HMW + different method triad

PASS 3 — Refine (max 2 passes):
  - If top weighted < 9.0 OR HumanKind < 7: pick weakest criterion, apply a DIFFERENT method from the triad (not the same one)
  - SCAMPER is mandatory on at least one pass when strategic_fit or simplicity scores < 8
  - Pre-mortem before presenting 9+ scores

Stopping:
  - Success: weighted ≥ 9.0 AND HumanKind ≥ 7
  - Plateau: 2 passes with delta < 0.2 → ship best with honest note
  - Max 2 refinement passes in this call (deeper recursion is engine responsibility)
`.trim();

const SCAMPER_IDEATION_RULE = `
## SCAMPER (required in ideation triad)

Pick three moves minimum: Substitute / Combine / Adapt / Modify / Put to other use / Eliminate / Reverse.
Apply to the most-defended brand assumption — not the product feature list.
`.trim();

function buildRecursiveRefineSection() {
  return [BRIEF_COMPLIANCE_8, '', RECURSIVE_REFINE_ALGORITHM, '', SCAMPER_IDEATION_RULE].join('\n');
}

module.exports = {
  BRIEF_COMPLIANCE_8,
  RECURSIVE_REFINE_ALGORITHM,
  SCAMPER_IDEATION_RULE,
  buildRecursiveRefineSection,
};
