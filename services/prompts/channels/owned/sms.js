'use strict';

/**
 * SMS marketing — opted-in, transactional + promo.
 *
 * Sources: Klaviyo + Postscript SMS benchmarks 2025, TCPA + GDPR compliance
 * notes.
 *
 * What performs:
 *   - 50-160 chars (one SMS segment) — split-message rates drop fast
 *   - Brand name in first 3 chars (so they don't think it's spam)
 *   - One CTA, with a short link
 *   - Personal-feeling, not broadcast
 *
 * What violates law or kills opt-in rate:
 *   - No opt-out language ("Reply STOP" — required by TCPA)
 *   - Send outside 8am-9pm local time (TCPA + GDPR Article 7)
 *   - >2 SMS per week per opt-in
 *   - Emoji-stuffed messages
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _charCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'sms',
  name: 'SMS',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'sms',
  source_citation: 'Klaviyo + Postscript SMS Benchmarks (2025)',
  channel_ids: ['sms'],
  format_rules: {
    max_chars: 160,
    length_window: { min: 30, max: 140, ideal: 90 },
    cta_count: 1,
    emoji_use: 'minimal',
    opt_out_required: true,
  },
  hook_patterns: [
    {
      name: 'Brand + offer',
      template: '"[Brand]: [specific offer], ends [date]. [link]"',
      why: 'Brand name first = recognized opt-in',
    },
    {
      name: 'Personal callback',
      template: '"[Brand]: [Specific item they liked] is back in stock. [link]"',
      why: 'Reference signal',
    },
    {
      name: 'Timing trigger',
      template: '"[Brand]: Your [order/appt] is [status]. [link]"',
      why: 'Transactional has 95%+ open rate',
    },
  ],
  anti_patterns: [
    { pattern: "congrats! you've won", why: 'Spam trigger' },
    { pattern: 'click here to claim', why: 'Phishing pattern' },
    { pattern: 'urgent', why: 'Over-used — diluted' },
  ],
  retention_mechanics: [
    'brand name in first 3 chars',
    'one short link, one ask',
    'send 8am-9pm local time',
    'opt-out "Reply STOP" appended',
    'no more than 2/week per opt-in',
  ],
  invariants: [
    { id: 'opt-out', rule: 'Include opt-out language ("Reply STOP")', kind: 'must_have' },
    { id: 'one-cta', rule: 'Single CTA + single short link', kind: 'must_have' },
    { id: 'char-limit', rule: '≤160 chars (one segment)', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyExtras(draft) {
    const fixes = [];
    if (_charCount(draft) > 160) {
      fixes.push({
        severity: 'block',
        issue: `SMS: ${_charCount(draft)} chars — exceeds single-segment ceiling`,
        suggestion: 'Cut to ≤160 chars or accept split-message rate.',
        span: null,
      });
    }
    if (!/STOP|opt[- ]?out/i.test(draft)) {
      fixes.push({
        severity: 'block',
        issue: 'SMS: missing opt-out language (TCPA/GDPR required)',
        suggestion: 'Append " Reply STOP to opt out" or equivalent.',
        span: null,
      });
    }
    return fixes;
  },
});
