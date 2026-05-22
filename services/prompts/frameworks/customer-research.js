'use strict';

/**
 * Customer research synthesis framework (adapted from coreyhaines31/marketingskills).
 * Used by voc/ and any interview/transcript synthesis path.
 */

const EXTRACTION_DIMENSIONS = `
## Extraction framework (per asset)

For each source (interview, survey, ticket, review, win/loss note), extract:

1. **Jobs to Be Done** — functional / emotional / social outcome the customer hires you for
2. **Pain points** — unprompted + emotionally charged language ranks higher
3. **Trigger events** — what changed that made them seek a solution (team growth, missed target, embarrassment, competitor move)
4. **Desired outcomes** — success in their exact words (verbatim, not paraphrase)
5. **Language & vocabulary** — phrases usable in ads/landing pages ("drowning in spreadsheets" > "manual inefficiency")
6. **Alternatives considered** — competitors, DIY, hiring, doing nothing

## Synthesis steps

1. Cluster by theme across assets
2. Score frequency + intensity (how often + how strongly felt)
3. Segment by profile (size, role, use case, tenure) — do not average unlike segments
4. Pick 5-10 "money quotes" per major theme
5. Flag contradictions (said vs did, prompted vs unprompted)

## Confidence labels (required on every insight)

| Level | Criteria |
|-------|----------|
| high | 3+ independent sources; unprompted; consistent across segments |
| medium | 2 sources OR only prompted OR one segment only |
| low | single source; outlier; needs validation |

Recency: weight last-12-month sources heavier. Sample bias: reviewers skew loud; tickets skew problems; Reddit skews technical.

Minimum viable sample: do not build personas or messaging conclusions from <5 independent data points per segment.
`.trim();

const INTERVIEW_SYNTHESIS = `
## Interview / transcript synthesis (Mode 1)

When input includes call transcripts or interview notes:

- Extract: pains, triggers, desired outcomes, exact language, objections, alternatives
- Find the **decision moment** — when they decided to look, what they tried before, what success looks like
- Win/loss: what tipped the decision; what almost sent them to a competitor
- NPS: passives + detractors > promoters for improvement work; pair score with verbatim

Output fields to enrich VOC JSON when transcripts present:
- "trigger_events": [{ "event": "...", "evidence_quotes": ["..."], "confidence": "high|medium|low" }]
- "positioning_implications": ["what this means for headline/offer — tied to quote"]
`.trim();

function buildCustomerResearchPromptSection() {
  return [EXTRACTION_DIMENSIONS, '', INTERVIEW_SYNTHESIS].join('\n\n');
}

module.exports = {
  EXTRACTION_DIMENSIONS,
  INTERVIEW_SYNTHESIS,
  buildCustomerResearchPromptSection,
};
