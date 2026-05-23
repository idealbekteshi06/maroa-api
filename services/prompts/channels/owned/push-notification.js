'use strict';

/**
 * Push notification — mobile app push, opted-in.
 *
 * Sources: OneSignal + Braze push benchmarks 2025, iOS + Android system
 * push behavior.
 *
 * What performs:
 *   - Title: 5-7 words (40 chars visible on lock screen)
 *   - Body: 1-2 sentences, 60-100 chars
 *   - Specific, personalized, time-sensitive
 *   - Deep link to relevant in-app screen (not just app open)
 *
 * What gets opt-out / blocked:
 *   - Generic "We miss you" sends
 *   - Off-hours (push at 3am)
 *   - >1/day for non-transactional
 *   - Promotional language without relevance
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _charCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'push-notification',
  name: 'Push Notification',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'notification',
  source_citation: 'OneSignal + Braze Push Benchmarks (2025)',
  channel_ids: ['push-notification'],
  format_rules: {
    title_max_chars: 40,
    body_max_chars: 100,
    length_window: { min: 8, max: 25, ideal: 14 },
    emoji_use: 'minimal',
    deep_link: 'required',
  },
  hook_patterns: [
    {
      name: 'Specific event',
      template: '"[Friend] just [did action]"',
      why: 'Social/specific events outperform generic',
    },
    {
      name: 'Resume hook',
      template: '"Your [item] is still in your cart — [discount?]"',
      why: 'Personalized resume = highest CTR',
    },
    { name: 'Real-time', template: '"[Event] just happened near you"', why: 'Real-time relevance' },
  ],
  anti_patterns: [
    { pattern: 'we miss you', why: 'Generic — triggers notification fatigue' },
    { pattern: 'check it out', why: 'Vague — no reason to tap' },
    { pattern: "don't forget", why: 'Reminder fatigue' },
  ],
  retention_mechanics: [
    'title 5-7 words, body 1-2 sentences',
    'specific event or personalized hook',
    'deep link to relevant screen',
    'send local time, business hours',
  ],
  invariants: [
    { id: 'char-limits', rule: 'Title ≤40 chars, body ≤100 chars', kind: 'must_have' },
    { id: 'deep-link', rule: 'Deep links to a relevant screen, not app open', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    if (_charCount(draft) > 140) {
      fixes.push({
        severity: 'block',
        issue: `Push: total ${_charCount(draft)} chars — over 140 (title + body)`,
        suggestion: 'Cut to 8-20 words total.',
        span: null,
      });
    }
    return fixes;
  },
});
