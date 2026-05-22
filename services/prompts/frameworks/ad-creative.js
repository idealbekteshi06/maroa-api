'use strict';

/**
 * Performance ad creative at scale (adapted from coreyhaines31/marketingskills ad-creative).
 */

const PLATFORM_SPECS = {
  google_rsa: {
    headline_max: 30,
    headline_count: 15,
    description_max: 90,
    description_count: 4,
    rules: 'Headlines must work in any combination; pin only when necessary; mix keyword + benefit + CTA headlines',
  },
  meta: {
    primary_visible: 125,
    primary_max: 2200,
    headline_rec: 40,
    description_rec: 30,
    rules: 'Front-load hook in first 125 chars; one idea per primary text variant',
  },
  linkedin: {
    intro_rec: 150,
    headline_rec: 70,
    rules: 'B2B: lead with outcome + social proof; avoid consumer hype',
  },
  tiktok: {
    ad_text_rec: 80,
    rules: 'Native, casual, pattern-interrupt first line',
  },
};

const VARIATION_LOOP = `
## Creative iteration loop

Pull performance data → identify winning patterns (CTR, CVR, ROAS by angle) → generate new variations that:
- Double down on top themes (new hooks, same promise)
- Explore orthogonal angles (new tension, same offer)
- Retire fatigued angles (frequency up + CTR down)

Per variant document: angle | hook | proof element | CTA | platform spec compliance
`.trim();

function buildAdCreativeSection(platform = 'meta') {
  const spec = PLATFORM_SPECS[platform] || PLATFORM_SPECS.meta;
  return [
    '## Ad creative generation',
    `Platform: ${platform}`,
    `\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    '',
    VARIATION_LOOP,
  ].join('\n');
}

module.exports = {
  PLATFORM_SPECS,
  VARIATION_LOOP,
  buildAdCreativeSection,
};
