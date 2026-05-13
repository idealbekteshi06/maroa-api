'use strict';

/**
 * Long-form landing page — direct-response, 800-3000 words.
 *
 * Sources: ConversionXL + Wynter landing-page benchmarks 2025,
 * Joanna Wiebe (Copyhackers) long-form playbook.
 *
 * What performs:
 *   - 800-2500 words for considered B2B/high-ticket purchases
 *   - Above-the-fold = single hero promise + single primary CTA
 *   - Objection-handling section near the bottom (FAQ or rebuttal)
 *   - Social proof every ~400 words
 *   - One primary CTA, repeated 3-5x throughout
 *
 * What underperforms:
 *   - Above-the-fold cluttered with multiple CTAs
 *   - Generic hero ("Welcome to our company")
 *   - Buzzword salad without specific outcomes
 *   - Auto-play video with audio (kills mobile conversion)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'landing-page-long',
  name: 'Long-Form Landing Page',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'landing',
  source_citation: 'ConversionXL + Wynter Landing Benchmarks (2025)',
  channel_ids: ['landing-page-long'],
  format_rules: {
    length_window: { min: 600, max: 2500, ideal: 1400 },
    sections: ['hero', 'problem', 'solution', 'proof', 'objections', 'cta'],
    primary_cta_repeats: { min: 3, max: 6 },
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Specific hero promise', template: '"[Outcome] in [time] without [pain]"', why: 'Outcome + time + objection-flip' },
    { name: 'Problem-aware hero', template: 'Lead with the specific pain, not the solution', why: 'For pain-aware traffic' },
    { name: 'Quote-led hero', template: 'Customer outcome quote + before/after metric', why: 'Proof above the fold' },
  ],
  anti_patterns: [
    { pattern: 'welcome to our', why: 'Generic — wastes the hero' },
    { pattern: 'world-class', why: 'Vague superlative — Critic flag' },
    { pattern: 'cutting-edge', why: 'Vague superlative — Critic flag' },
    { pattern: 'revolutionary', why: 'Vague superlative — Critic flag' },
    { pattern: 'one-stop shop', why: 'Generic — no positioning' },
  ],
  retention_mechanics: [
    'hero = single promise + single CTA above the fold',
    'proof every ~400 words',
    'objection-handling section near the bottom',
    'primary CTA repeats 3-5x',
    'no auto-play video with audio',
  ],
  invariants: [
    { id: 'single-primary-cta', rule: 'One primary CTA repeated, not multiple competing CTAs', kind: 'must_have' },
    { id: 'no-vague-superlatives', rule: 'No "world-class / cutting-edge / revolutionary"', kind: 'must_avoid' },
  ],
  manipulation_risk: 2,
});
