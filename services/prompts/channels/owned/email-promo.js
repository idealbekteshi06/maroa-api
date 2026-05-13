'use strict';

/**
 * Promotional email — discount, launch, BFCM-style, opt-in audience.
 *
 * Sources: Klaviyo + Omnisend promo-email benchmarks 2025, Halbert
 * direct-response principles.
 *
 * What performs:
 *   - Subject with the offer in it ("48% off — last day")
 *   - Hero image with offer overlay
 *   - 50-150 words supporting copy
 *   - Strong specific deadline (date/time, not "soon")
 *   - One BIG CTA, repeated 2x (top + bottom of email)
 *
 * What gets reported as spam / unsubscribed:
 *   - "FREE!!!" "$$$" "100%" — classic spam triggers
 *   - Mismatched subject and body
 *   - Discount with no deadline (kills urgency entirely)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'email-promo',
  name: 'Promotional Email',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'email',
  source_citation: 'Klaviyo + Omnisend Promo Benchmarks (2025)',
  channel_ids: ['email-promo'],
  format_rules: {
    subject_max_words: 9,
    length_window: { min: 40, max: 150, ideal: 80 },
    cta_count: 2,
    emoji_use: 'minimal',
    deadline: 'required',
  },
  hook_patterns: [
    { name: 'Offer in subject', template: '"[%]X off — ends [date]"', why: 'Subject pre-sells the offer' },
    { name: 'Urgency subject', template: '"Last day for [offer]"', why: 'Real deadline beats vague urgency' },
    { name: 'Number-led headline', template: '"$X off this week only"', why: 'Specific beats "save big"' },
  ],
  anti_patterns: [
    { pattern: 'free!!!', why: 'Spam trigger — high deliverability hit' },
    { pattern: '$$$', why: 'Spam trigger' },
    { pattern: '100% free', why: 'Spam trigger' },
    { pattern: 'act now', why: 'Vague urgency — pair with real deadline' },
    { pattern: 'don\'t miss out', why: 'Vague urgency' },
  ],
  retention_mechanics: [
    'offer in the subject line',
    'hero image with offer overlay',
    'one CTA, repeated 2x',
    'specific deadline (date + time)',
    'product/outcome visible above the fold',
  ],
  invariants: [
    { id: 'specific-deadline', rule: 'Offer has a real date/time deadline', kind: 'must_have' },
    { id: 'no-spam-triggers', rule: 'No "FREE!!!" / "$$$" / "100% free"', kind: 'must_avoid' },
  ],
  manipulation_risk: 3,
});
