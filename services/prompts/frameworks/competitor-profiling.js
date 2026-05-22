'use strict';

/**
 * Competitor URL profiling framework (adapted from coreyhaines31/marketingskills).
 * Complements workflow_5 weekly movement analysis with dossier depth.
 */

const DOSSIER_TEMPLATE = `
## Competitor dossier (per URL)

Facts over opinions — every claim traceable to scraped/review/SEO evidence. Label inferences.

| Section | Extract |
|---------|---------|
| Homepage | Headline, subhead, value prop, primary CTA, social proof, TA signals |
| Pricing | Tiers, prices, feature gates, trial/free tier, enterprise signals |
| Features | Categories, key capabilities, how they describe each |
| About | Team size, funding, mission, HQ |
| Customers | Named logos, industries, case study themes |
| Integrations | Count, key partners, categories |
| Changelog | Release velocity, recent product direction |

## Core principles

1. Structured and comparable — same sections for every competitor
2. Current snapshot — include as_of date; flag stale pricing/pages
3. Honest assessment — do not exaggerate weaknesses or hide strengths
4. Never recommend naming competitors in customer-facing copy (legal/brand risk)

## Cross-competitor summary

After individual dossiers:
- Positioning map (who owns which claim)
- Pricing posture (premium / mid / race-to-bottom)
- White space (underserved segment + why now)
- Threat ranking with evidence, not vibes
`.trim();

function buildCompetitorProfilingSection() {
  return DOSSIER_TEMPLATE;
}

module.exports = {
  DOSSIER_TEMPLATE,
  buildCompetitorProfilingSection,
};
