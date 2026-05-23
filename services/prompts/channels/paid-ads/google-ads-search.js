'use strict';

/**
 * Google Ads — Search (Responsive Search Ads).
 *
 * Sources: Google Ads Help (RSA) 2025, Wordstream benchmark 2025.
 *
 * Format (RSA):
 *   - Up to 15 headlines (30 char max each), Google picks 3-4 to display
 *   - Up to 4 descriptions (90 char max each), Google picks 2
 *   - 1 final URL
 *
 * What performs:
 *   - Headlines vary in angle (benefit / brand / CTA / specific number /
 *     question) so Google has options to combine
 *   - Description repeats top benefit + adds urgency or specificity
 *   - At least one headline includes the target keyword
 *   - At least one headline has the geo (for local intent)
 *
 * What gets disapproved:
 *   - ALL CAPS HEADLINES
 *   - Exclamation marks in headlines (max 1 allowed in description, 0 in
 *     headline)
 *   - Trademark misuse in copy
 *   - Phone number in headline (use call extension)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'google-ads-search',
  name: 'Google Search Ad (RSA)',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'search_result',
  source_citation: 'Google Ads Help + Wordstream Benchmark (2025)',
  channel_ids: ['google-ads-search'],
  format_rules: {
    headline_max_chars: 30,
    headline_count: { min: 8, max: 15 },
    description_max_chars: 90,
    description_count: { min: 2, max: 4 },
    emoji_use: 'none',
    all_caps_words: 'disallowed',
  },
  hook_patterns: [
    { name: 'Keyword headline', template: '"[Keyword] in [City]"', why: 'Google rewards keyword match' },
    {
      name: 'Specific number',
      template: '"Save 20%" / "Free Shipping" / "From $49"',
      why: 'Numbers cut through noise',
    },
    { name: 'Question headline', template: '"Looking for [keyword]?"', why: 'Matches user intent phrasing' },
    {
      name: 'Trust signal',
      template: '"[N]-Star Rated" / "[N]K+ Customers"',
      why: 'Outperforms generic "Best..." claims',
    },
  ],
  anti_patterns: [
    { pattern: 'all caps', why: 'Google disapproves ALL-CAPS words' },
    { pattern: 'click here', why: 'Generic — wastes a headline slot' },
    { pattern: 'guaranteed', why: 'Auto-flagged in regulated verticals' },
    { pattern: 'best ever', why: 'Superlatives without proof — disapproved' },
  ],
  retention_mechanics: [
    'pin 1-2 headlines if specific position required (geo, keyword)',
    'mix headline angles (benefit / question / number / brand / CTA)',
    'descriptions repeat top benefit + call to action',
    'use callouts + sitelinks for additional info instead of cramming headlines',
  ],
  invariants: [
    { id: 'headline-count', rule: '≥8 headlines (Google needs combos to A/B)', kind: 'must_have' },
    { id: 'headline-length', rule: 'All headlines ≤30 chars', kind: 'must_have' },
    { id: 'no-all-caps', rule: 'No ALL CAPS words in headlines', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
