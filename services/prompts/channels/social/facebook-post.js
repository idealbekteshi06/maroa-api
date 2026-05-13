'use strict';

/**
 * Facebook feed post — Meta's oldest surface, organic reach is low.
 *
 * Sources: Meta Newsroom (Facebook Feed ranking), Buffer Facebook benchmark
 * 2025.
 *
 * What performs:
 *   - 40-80 words (longer underperforms — FB favors quick reads)
 *   - Photo or short video attached (text-only ~0% organic reach in 2025)
 *   - Direct, plain language — older + broader audience
 *   - Local/community angle (FB still wins on local audiences)
 *
 * What gets downranked:
 *   - "Buy now" / direct sales in caption
 *   - Outbound links from the page (use Marketplace or Shops if commerce)
 *   - News/political content (FB explicitly deprioritizes since 2021)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'facebook-post',
  name: 'Facebook Post',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'Meta Newsroom + Buffer Facebook Benchmark (2025)',
  channel_ids: ['facebook-post'],
  format_rules: {
    length_window: { min: 30, max: 100, ideal: 60 },
    emoji_use: 'natural',
    media: 'required_for_reach',
    hashtag_count: { min: 0, max: 3 },
  },
  hook_patterns: [
    { name: 'Local hook', template: 'Reference the city/region by name', why: 'FB algorithm boosts local relevance' },
    { name: 'Question', template: 'Genuine question to community', why: 'Comments still drive FB reach' },
    { name: 'Story moment', template: 'Specific 1-2 sentence anecdote', why: 'Outperforms abstract advice' },
  ],
  anti_patterns: [
    { pattern: 'buy now', why: 'Triggers promotional downrank' },
    { pattern: 'click the link', why: 'Outbound links massively deprioritized' },
    { pattern: 'limited time', why: 'Promo language = downranked' },
  ],
  retention_mechanics: [
    'lead with photo or video',
    'keep text short',
    'local/community angle if applicable',
    'use the page name + location in profile, not in caption',
  ],
  invariants: [
    { id: 'media-required', rule: 'Photo or video attached (text-only kills reach)', kind: 'must_have' },
  ],
  manipulation_risk: 1,
});
