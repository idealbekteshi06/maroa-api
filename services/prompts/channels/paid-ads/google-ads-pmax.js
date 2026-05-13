'use strict';

/**
 * Google Performance Max — asset-based campaign across Search, Display,
 * Discover, Gmail, YouTube, Maps.
 *
 * Sources: Google Ads Help (PMax) 2025, Optmyzr PMax benchmark 2025.
 *
 * Asset requirements:
 *   - Headlines: 5 short (30 chars) + 5 long (90 chars)
 *   - Descriptions: 5 (90 chars)
 *   - Images: portrait/square/landscape — at least 1 of each
 *   - Logos: at least 1
 *   - Video: at least 1 (Google auto-generates if missing — usually
 *     low-quality, so supply your own)
 *
 * What performs:
 *   - Strong audience signals (customer match, website visitors as seed)
 *   - High-quality video assets (don't let Google auto-generate)
 *   - Asset variety — Google's ML needs combinations to test
 *
 * What gets disapproved / underperforms:
 *   - Same restrictions as Search (no ALL CAPS, etc.)
 *   - Letting Google auto-generate video (degrades CTR ~30% vs supplied)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'google-ads-pmax',
  name: 'Google Performance Max',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_image',
  source_citation: 'Google Ads Help (PMax) + Optmyzr Benchmark (2025)',
  channel_ids: ['google-ads-pmax'],
  format_rules: {
    short_headline_max_chars: 30,
    short_headline_count: { min: 3, max: 5 },
    long_headline_max_chars: 90,
    long_headline_count: { min: 1, max: 5 },
    description_max_chars: 90,
    description_count: { min: 2, max: 5 },
    image_count: { min: 4, max: 20 },
    video_count: { min: 1, max: 5 },
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Multi-angle asset set', template: '5 short headlines, each a different benefit/angle', why: 'PMax needs combinations to test' },
    { name: 'Brand + product mix', template: 'Some assets brand-led, some product-led', why: 'PMax serves multiple intents' },
  ],
  anti_patterns: [
    { pattern: 'all caps', why: 'Google disapproves ALL-CAPS words' },
    { pattern: 'click here', why: 'Wastes a slot' },
  ],
  retention_mechanics: [
    'supply at least 1 video — never let Google auto-generate',
    'asset variety — different angles, not just rephrased copy',
    'feed audience signals (customer match, site visitors)',
  ],
  invariants: [
    { id: 'asset-count', rule: 'All asset types meet min counts', kind: 'must_have' },
    { id: 'no-all-caps', rule: 'No ALL CAPS words', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
