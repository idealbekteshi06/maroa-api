'use strict';

/**
 * Nurture email — to opted-in subscribers, builds trust over time.
 *
 * Sources: Ann Handley + Joanna Wiebe nurture-sequence playbooks 2025,
 * Klaviyo + Mailchimp benchmark 2025.
 *
 * What performs:
 *   - Subject: 4-8 words, curiosity-driven (not promo-sounding)
 *   - 150-400 words — long enough to deliver real value
 *   - One core idea, one CTA at the end (soft, not pushy)
 *   - Conversational voice — write like a 1:1 message, not a broadcast
 *   - Specific stories beat generic tips
 *
 * What underperforms / gets unsubscribed:
 *   - "Hey [first name]!" opener (template tell)
 *   - Discount-only emails (kills the trust loop)
 *   - >500 words (skim rate plummets)
 *   - Multiple competing CTAs
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'email-nurture',
  name: 'Nurture Email',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'email',
  source_citation: 'Handley/Wiebe nurture playbooks + Klaviyo Benchmark (2025)',
  channel_ids: ['email-nurture'],
  format_rules: {
    subject_max_words: 8,
    length_window: { min: 120, max: 400, ideal: 220 },
    cta_count: 1,
    emoji_use: 'minimal',
    cta_placement: 'end_only',
  },
  hook_patterns: [
    {
      name: 'Story open',
      template: 'Specific 1-2 sentence anecdote, then zoom out',
      why: 'Stories outperform tips in nurture',
    },
    { name: 'Curiosity subject', template: '"The mistake I made last week"', why: 'Curiosity > urgency in nurture' },
    {
      name: 'Question subject',
      template: '"Are you doing this [common thing]?"',
      why: 'Reads as a friend, not a broadcast',
    },
  ],
  anti_patterns: [
    { pattern: 'hey [first name]', why: 'Template tell — kills the 1:1 feel' },
    { pattern: 'limited time only', why: 'Promo language — wrong for nurture' },
    { pattern: "don't miss out", why: 'FOMO in nurture damages trust' },
    { pattern: "p.s. don't forget", why: 'Pushy — wrong tone' },
  ],
  retention_mechanics: [
    'subject driven by curiosity, not promo',
    'conversational voice — write like a 1:1 message',
    'one core idea per email',
    'one CTA at the end (soft, not pushy)',
    'specific stories > generic tips',
  ],
  invariants: [
    { id: 'one-cta', rule: 'Single CTA only', kind: 'must_have' },
    { id: 'no-discount-language', rule: 'No "limited time" / "don\'t miss out" in nurture', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    if (_wordCount(draft) > 500) {
      fixes.push({
        severity: 'suggest',
        issue: `Nurture email: ${_wordCount(draft)} words — over 400 sweet spot`,
        suggestion: 'Cut to 150-300 words; nurture emails should feel reading-easy.',
        span: null,
      });
    }
    return fixes;
  },
});
