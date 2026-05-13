'use strict';

/**
 * Meta carousel ad — 2-10 cards, each with image + headline + description.
 *
 * Sources: Meta Ads Manager + Klaviyo carousel benchmark 2025.
 *
 * What performs:
 *   - 3-5 cards (more than 6 drops completion sharply)
 *   - Each card = one benefit OR one product (don't mix)
 *   - First card = hook + value prop
 *   - Last card = single strong CTA (not on every card)
 *   - Coherent visual style across cards (same color/grid/style)
 *
 * What gets downranked / disapproved:
 *   - Same hook copy duplicated across cards (anti-spam flag)
 *   - >7 cards (engagement drops below noise floor)
 *   - Mixed product + benefit narratives
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'meta-ads-carousel',
  name: 'Meta Carousel Ad',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_image',
  source_citation: 'Meta Ads Manager + Klaviyo Carousel Benchmark (2025)',
  channel_ids: ['meta-ads-carousel'],
  format_rules: {
    card_count: { min: 2, max: 10, ideal: 4 },
    primary_text_max_chars: 280,
    headline_max_chars: 40,
    description_max_chars: 30,
    emoji_use: 'minimal',
  },
  hook_patterns: [
    { name: 'Benefit ladder', template: 'Card 1: hook. Cards 2-4: benefits. Card 5: CTA.', why: 'Cascading benefits earn the swipe' },
    { name: 'Product showcase', template: 'One card per product, same style', why: 'For e-commerce — high catalog discovery' },
    { name: 'Step-by-step', template: 'Step 1, Step 2, Step 3, Outcome card', why: 'Tutorial framing earns swipes' },
  ],
  anti_patterns: [
    { pattern: 'duplicate hook', why: 'Same headline on every card = spam flag' },
  ],
  retention_mechanics: [
    'first card = hook + value prop',
    'each card delivers ONE distinct payoff',
    'last card = single strong CTA',
    'visual style coherent across cards',
  ],
  invariants: [
    { id: 'card-count', rule: '2-7 cards (sweet spot 3-5)', kind: 'must_have' },
    { id: 'one-cta-card', rule: 'CTA card is the last one, not all of them', kind: 'must_have' },
  ],
  manipulation_risk: 1,
});
