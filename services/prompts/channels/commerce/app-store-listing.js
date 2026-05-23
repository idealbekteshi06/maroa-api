'use strict';

/**
 * App Store / Play Store listing — title + subtitle + description.
 *
 * Sources: Apple App Store Guidelines + Google Play Console docs 2025,
 * AppTweak + Sensor Tower ASO benchmarks 2025.
 *
 * Format (Apple):
 *   - App name: 30 chars
 *   - Subtitle: 30 chars
 *   - Description: 4000 chars (first 3 lines matter most)
 *   - Keywords field: 100 chars (Apple only)
 *
 * What performs:
 *   - Title with primary keyword (Apple weighs heavily)
 *   - Subtitle with secondary keyword + benefit
 *   - First 3 lines of description = hook + value prop + social proof
 *   - Specific user outcome metrics ("3M+ downloads", "4.8 stars")
 *
 * What gets rejected / underperforms:
 *   - Trademark misuse ("like Uber for X")
 *   - Keyword stuffing in name (Apple rejects)
 *   - Vague description ("the best app for productivity")
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'app-store-listing',
  name: 'App Store Listing',
  category: CHANNEL_CATEGORIES.COMMERCE,
  surface_type: 'listing',
  source_citation: 'Apple App Store + Google Play Console + AppTweak ASO Benchmarks (2025)',
  channel_ids: ['app-store-listing'],
  format_rules: {
    name_max_chars: 30,
    subtitle_max_chars: 30,
    description_max_chars: 4000,
    length_window: { min: 200, max: 1500, ideal: 600 },
    keyword_density: 'high',
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Keyword-led name', template: '"[App name]: [Primary keyword]"', why: 'Apple weighs name keyword heavily' },
    { name: 'Benefit subtitle', template: '"Get [outcome] in [time]"', why: 'Subtitle is the secondary hook' },
    {
      name: 'Social proof open',
      template: '"4.8★ from 100K+ users — [hook line]"',
      why: 'Proof in first 3 visible lines',
    },
  ],
  anti_patterns: [
    { pattern: 'like uber for', why: 'Trademark misuse — Apple rejects' },
    { pattern: 'the best app', why: 'Vague superlative — App Store flag' },
    { pattern: 'world-class', why: 'Vague superlative' },
  ],
  retention_mechanics: [
    'keyword in name (Apple) + title (Play)',
    'first 3 lines of description carry the hook',
    'specific metrics + social proof up top',
    "screenshots tell the story (most users don't read past 3 lines)",
  ],
  invariants: [
    { id: 'name-length', rule: 'App name ≤30 chars', kind: 'must_have' },
    { id: 'no-trademark-misuse', rule: 'No "like [brand] for X" framing', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
