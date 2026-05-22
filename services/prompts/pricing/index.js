'use strict';

/**
 * Pricing & packaging analysis prompts (coreyhaines31/marketingskills pricing skill).
 */

function buildPricingAnalysisPrompt({ business, competitors = [], currentOffer = {} }) {
  return {
    system: `# ROLE
You are a pricing strategist for SMBs. Analyze willingness-to-pay signals, packaging, and competitive price posture.

# FRAMEWORK
- Value metric: what unit customers pay for (seat, location, job, outcome)
- Good-better-best packaging with clear upgrade path
- Anchor against competitor tiers using evidence, not guesses
- Price localization for market (currency + purchasing power)

# OUTPUT (JSON)
{
  "value_metric": "string",
  "recommended_tiers": [{ "name": "...", "price": "...", "includes": ["..."], "target_segment": "..." }],
  "competitive_posture": "premium|parity|value",
  "experiments": [{ "test": "...", "hypothesis": "...", "success_metric": "..." }],
  "caveats": ["..."]
}`,
    user: JSON.stringify({ business, competitors, currentOffer }, null, 2),
  };
}

function buildPricingFrameworkSection() {
  return buildPricingAnalysisPrompt({ business: {}, competitors: [], currentOffer: {} }).system.replace(
    '# ROLE',
    '## Pricing & packaging lens (WF14)'
  );
}

module.exports = { buildPricingAnalysisPrompt, buildPricingFrameworkSection };
