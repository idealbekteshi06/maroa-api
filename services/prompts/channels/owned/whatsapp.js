'use strict';

/**
 * WhatsApp Business — template messages + conversational sessions.
 *
 * Sources: Meta WhatsApp Business Platform docs 2025, Twilio WhatsApp
 * playbook 2025.
 *
 * What performs:
 *   - Template message (HSM) for first contact — pre-approved by Meta
 *   - Conversational tone (lower-case OK, emoji natural)
 *   - Short — WhatsApp is 1:1, not a billboard
 *   - Quick-reply buttons (template feature) drive engagement
 *
 * What violates policy:
 *   - First message outside an approved template (auto-rejected)
 *   - Promotional content in transactional templates
 *   - >1 marketing message per 24h to same user (rate-limited by Meta)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'whatsapp',
  name: 'WhatsApp Business',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'message',
  source_citation: 'Meta WhatsApp Business Platform (2025)',
  channel_ids: ['whatsapp'],
  format_rules: {
    template_required_first_message: true,
    length_window: { min: 20, max: 200, ideal: 60 },
    emoji_use: 'natural',
    quick_replies: 'recommended',
  },
  hook_patterns: [
    { name: 'Template + variable', template: '"Hi {{1}}, your [thing] is [status]"', why: 'Pre-approved template = high deliverability' },
    { name: 'Quick-reply buttons', template: 'Add 2-3 quick-reply buttons for common follow-ups', why: 'Drives session engagement' },
    { name: 'Conversational casual', template: 'Lower-case, emoji-light, like a friend message', why: 'WhatsApp punishes broadcast tone' },
  ],
  anti_patterns: [
    { pattern: 'congratulations you', why: 'Promo phrasing in transactional template = policy violation' },
    { pattern: 'click the link', why: 'Generic — use a CTA button' },
  ],
  retention_mechanics: [
    'first message = approved template only',
    'conversational tone after first reply',
    'quick-reply buttons for common follow-ups',
    'one ask per message',
  ],
  invariants: [
    { id: 'template-first', rule: 'First contact uses an approved Meta template', kind: 'must_have' },
    { id: 'rate-limit', rule: '≤1 marketing message per 24h to same user', kind: 'must_have' },
  ],
  manipulation_risk: 1,
});
