'use strict';

/**
 * Pinterest Pin — visual search + intent-driven discovery.
 *
 * Sources: Pinterest Business + Tailwind benchmark 2025.
 *
 * Pinterest is SEARCH, not a social feed — keywords matter more than
 * cleverness. The title + description should read like a search query.
 *
 * What performs:
 *   - 2:3 vertical image (1000×1500px)
 *   - Title with specific keyword (e.g. "Easy gluten-free banana bread recipe")
 *   - Description with 4-8 sentences, keyword-rich
 *   - Text overlay on the image (Pinterest is visual + skimmable)
 *
 * What gets downranked:
 *   - Square or landscape (not vertical)
 *   - Vague title (no keyword intent)
 *   - Spammy hashtag stacking
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'pinterest-pin',
  name: 'Pinterest Pin',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'Pinterest Business + Tailwind Benchmark (2025)',
  channel_ids: ['pinterest-pin'],
  format_rules: {
    aspect_ratio: '2:3',
    title_max_chars: 100,
    description_length_window: { min: 60, max: 200, ideal: 120 },
    hashtag_count: { min: 0, max: 5 },
    keyword_density: 'high',
    emoji_use: 'minimal',
  },
  hook_patterns: [
    {
      name: 'Keyword-front title',
      template: '"[Keyword] for [audience] — [outcome] in [time]"',
      why: 'Pinterest search ranks on title keyword',
    },
    { name: 'Listicle pin', template: '"7 [items] you need for [outcome]"', why: 'Listicle pins get the most saves' },
    {
      name: 'Tutorial',
      template: '"How to [outcome] in [time]"',
      why: 'How-to is the highest-intent Pinterest query type',
    },
  ],
  anti_patterns: [
    { pattern: 'click here', why: 'no keyword value' },
    { pattern: 'sale', why: 'promo language deprioritized' },
  ],
  retention_mechanics: [
    'vertical 2:3 aspect ratio',
    'text overlay on the image (readable at thumbnail size)',
    'description repeats title keyword + 3-5 supporting keywords',
    'link directly to a relevant URL (Pinterest is intent-driven traffic)',
  ],
  invariants: [
    { id: 'aspect-ratio', rule: '2:3 vertical', kind: 'must_have' },
    { id: 'keyword-title', rule: 'Title contains the target search keyword', kind: 'must_have' },
  ],
  manipulation_risk: 0,
});
