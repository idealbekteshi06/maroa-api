'use strict';

const { buildAdCreativeSection, PLATFORM_SPECS } = require('../frameworks/ad-creative');

function buildAdCreativePrompt({ business, platform = 'meta', performanceSnapshot = {}, angles = [] }) {
  return {
    system: `# ROLE
You generate performance ad creative variations at scale for a small business.

${buildAdCreativeSection(platform)}

# OUTPUT (JSON)
{
  "variants": [
    {
      "angle": "...",
      "primary_text": "...",
      "headline": "...",
      "description": "...",
      "cta": "...",
      "spec_compliant": true
    }
  ],
  "retire": ["underperforming angles to pause"],
  "test_plan": "what to A/B first and why"
}`,
    user: JSON.stringify({ business, platform, performanceSnapshot, angles }, null, 2),
  };
}

module.exports = {
  PLATFORM_SPECS,
  buildAdCreativePrompt,
  buildAdCreativeSection,
};
