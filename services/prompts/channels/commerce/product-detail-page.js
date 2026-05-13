'use strict';

/**
 * Product detail page (PDP) — e-commerce single-product page.
 *
 * Sources: Baymard Institute + Nielsen Norman PDP research 2024-2025,
 * Shopify + Klaviyo PDP benchmarks 2025.
 *
 * What performs:
 *   - Title: brand + product + 1 key spec (e.g. "Allbirds Wool Runner — Mizzle")
 *   - Hero image + 4-7 supporting images
 *   - 2-3 sentence summary above the fold
 *   - Bullet list of 4-7 specs/benefits
 *   - Reviews block (95% of shoppers check before buying)
 *   - Shipping/returns clearly visible
 *
 * What underperforms:
 *   - Wall-of-text description
 *   - No reviews surfaced
 *   - Hidden shipping costs (#1 cart-abandon reason)
 *   - Vague benefit language
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'product-detail-page',
  name: 'Product Detail Page',
  category: CHANNEL_CATEGORIES.COMMERCE,
  surface_type: 'landing',
  source_citation: 'Baymard Institute + Nielsen Norman PDP Research (2024-2025)',
  channel_ids: ['product-detail-page'],
  format_rules: {
    title_pattern: 'brand + product + spec',
    summary_length_window: { min: 30, max: 80, ideal: 50 },
    description_length_window: { min: 100, max: 400, ideal: 200 },
    bullet_count: { min: 4, max: 7 },
    image_count: { min: 4, max: 8 },
    reviews_required: true,
    emoji_use: 'minimal',
  },
  hook_patterns: [
    { name: 'Brand + product + spec', template: '"[Brand] [Product] — [Color/Size/Spec]"', why: 'Matches buyer search behavior' },
    { name: 'Outcome summary', template: '2-3 sentences: who it\'s for, what it solves, why it\'s different', why: 'Above-the-fold summary drives scroll' },
    { name: 'Benefit bullets', template: '4-7 bullets, each a specific benefit + supporting detail', why: 'Scannable spec read' },
  ],
  anti_patterns: [
    { pattern: 'world-class', why: 'Vague — say what it specifically does' },
    { pattern: 'one-size-fits-all', why: 'PDP cliché' },
  ],
  retention_mechanics: [
    'title = brand + product + 1 key spec',
    '2-3 sentence summary above the fold',
    '4-7 bullets, each benefit + detail',
    'reviews surfaced near the buy button',
    'shipping + returns visible (not buried)',
  ],
  invariants: [
    { id: 'reviews-surfaced', rule: 'Customer reviews shown on the page', kind: 'must_have' },
    { id: 'shipping-visible', rule: 'Shipping cost visible before checkout', kind: 'must_have' },
  ],
  manipulation_risk: 0,
});
