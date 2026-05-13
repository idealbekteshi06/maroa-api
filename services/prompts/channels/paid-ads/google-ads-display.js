'use strict';

/**
 * Google Display Network — Responsive Display Ads (images + headlines).
 *
 * Sources: Google Ads Help (RDA) 2025.
 *
 * What performs:
 *   - Up to 5 short headlines (30 chars), 5 long headlines (90 chars),
 *     5 descriptions (90 chars), 5 logos, 15 images
 *   - Tight benefit + clear CTA — display has lower intent than search
 *   - Visual identity consistent with site (avoids "I clicked but it doesn't
 *     match" bounce)
 *
 * What gets disapproved / underperforms:
 *   - Misleading "system-style" creatives that look like OS errors
 *   - Trick "you've won" copy
 *   - Animated GIFs with rapid flash (accessibility rule)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'google-ads-display',
  name: 'Google Display Ad',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_image',
  source_citation: 'Google Ads Help (RDA) 2025',
  channel_ids: ['google-ads-display'],
  format_rules: {
    short_headline_max_chars: 30,
    long_headline_max_chars: 90,
    description_max_chars: 90,
    image_count: { min: 1, max: 15 },
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Single benefit', template: 'One specific outcome on screen', why: 'Display has lower intent — keep simple' },
    { name: 'Recall ad', template: 'Brand + product, simple visual', why: 'For retargeting / brand awareness' },
  ],
  anti_patterns: [
    { pattern: 'you\'ve won', why: 'Trick copy — auto-disapproved' },
    { pattern: 'system alert', why: 'Misleading creative — disapproved' },
    { pattern: 'one weird trick', why: 'Spam pattern — disapproved' },
  ],
  retention_mechanics: [
    'visual identity matches landing page',
    'one benefit + one CTA',
    'avoid animated flash / rapid GIFs',
  ],
  invariants: [
    { id: 'no-trick-copy', rule: 'No fake-system / fake-prize copy', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
