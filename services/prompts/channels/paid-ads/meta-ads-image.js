'use strict';

/**
 * Meta (Facebook + Instagram) image ad — primary text + headline + image.
 *
 * Sources: Meta Ads Library + Meta Business Help Center 2025, ConvertKit
 * + Motion ad-spend benchmark 2025.
 *
 * What performs:
 *   - Primary text: 70-140 chars (visible portion before "see more" on FB
 *     mobile is 80; on IG is 125)
 *   - Headline: 30-40 chars
 *   - Single benefit + single CTA per ad
 *   - Image with light text overlay (Meta no longer enforces 20% rule but
 *     dense text still underperforms)
 *
 * What gets disapproved or downranked:
 *   - "You" pronouns referring to attributes (Meta personal-attributes
 *     policy) — e.g. "you're overweight"
 *   - "Before/after" body images
 *   - Click-bait absolutes ("Lose 20 lbs in 7 days")
 *   - Discount-only ads without product context
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _charCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'meta-ads-image',
  name: 'Meta Image Ad',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_image',
  source_citation: 'Meta Ads Library + Motion Ad-Spend Benchmark (2025)',
  channel_ids: ['meta-ads-image'],
  format_rules: {
    primary_text_max_chars: 280,
    visible_primary_text_chars: 125,
    headline_max_chars: 40,
    description_max_chars: 30,
    length_window: { min: 60, max: 280, ideal: 140 },
    emoji_use: 'minimal',
    cta_button: 'required',
  },
  hook_patterns: [
    { name: 'Specific outcome', template: '[Audience]: [specific outcome] in [time].', why: 'Specificity beats hype' },
    {
      name: 'Problem call-out',
      template: "Tired of [specific pain]? Here's what works:",
      why: 'Direct-response classic',
    },
    {
      name: 'Social proof open',
      template: '"[Quoted customer line]" — [specific outcome metric]',
      why: 'Quote opener earns the read',
    },
    {
      name: 'Curiosity gap',
      template: '"The [unexpected reason] [target audience] [outcome]"',
      why: 'Forces the "see more" tap',
    },
  ],
  anti_patterns: [
    { pattern: "you're overweight", why: 'Meta personal attributes policy — auto-reject' },
    { pattern: 'lose 20 lbs', why: 'Health-outcome absolute — auto-reject' },
    { pattern: 'guaranteed results', why: 'Auto-flagged for review' },
    { pattern: 'click here', why: 'Generic CTA — use the button instead' },
    { pattern: 'limited time only', why: 'Vague urgency — Meta deprioritizes' },
  ],
  retention_mechanics: [
    'first 80-125 chars must hook (visible portion)',
    'one benefit + one CTA — no multi-bench combos',
    'image with light text overlay (≤20% area)',
    'CTA matches the action ("Shop", "Sign up", "Learn more")',
  ],
  invariants: [
    { id: 'no-personal-attributes', rule: 'No "you are [attribute]" phrasing', kind: 'must_avoid' },
    { id: 'no-absolute-claims', rule: 'No "guaranteed", "lose X in Y days" health claims', kind: 'must_avoid' },
    { id: 'visible-hook', rule: 'First 80-125 chars carries the value prop', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyExtras(draft) {
    const fixes = [];
    if (_charCount(draft) > 280) {
      fixes.push({
        severity: 'block',
        issue: `Meta image ad: primary text ${_charCount(draft)} chars > 280 ceiling`,
        suggestion: 'Cut to ≤280 chars; ideally ≤140.',
        span: null,
      });
    }
    return fixes;
  },
});
