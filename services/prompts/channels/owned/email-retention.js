'use strict';

/**
 * Retention email — to existing customers (winback, anniversary, milestone,
 * appreciation).
 *
 * Sources: Klaviyo retention benchmarks 2025, Drift conversational marketing
 * playbook 2025.
 *
 * What performs:
 *   - Appreciative tone (NOT salesy)
 *   - Reference their specific use/purchase ("you've been with us 12 months")
 *   - One soft CTA — and often, NO CTA (just appreciation)
 *   - Short — 60-120 words
 *
 * What underperforms / damages relationship:
 *   - Treating existing customers like prospects ("Save 20% on your first
 *     order!")
 *   - Generic newsletter content
 *   - Heavy discount language
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'email-retention',
  name: 'Retention Email',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'email',
  source_citation: 'Klaviyo + Drift retention playbooks (2025)',
  channel_ids: ['email-retention'],
  format_rules: {
    subject_max_words: 8,
    length_window: { min: 40, max: 130, ideal: 70 },
    cta_count: 1,
    emoji_use: 'minimal',
    tone: 'appreciative',
  },
  hook_patterns: [
    {
      name: 'Anniversary',
      template: '"It\'s been [N] months — thanks for being with us"',
      why: 'Specific relationship marker',
    },
    {
      name: 'Milestone callback',
      template: 'Reference their specific usage ("you\'ve [done X] this year")',
      why: 'Personalized retention beats discount',
    },
    {
      name: 'Insider preview',
      template: '"You\'re getting [thing] first because you\'re a customer"',
      why: 'Status reward — Cialdini reciprocity',
    },
  ],
  anti_patterns: [
    { pattern: 'save 20% on your first', why: 'Treats existing customer as prospect — damaging' },
    { pattern: 'sign up today', why: 'They already signed up' },
    { pattern: "don't miss out", why: 'Wrong tone for retention' },
  ],
  retention_mechanics: [
    'appreciative, not salesy',
    'reference their specific behavior',
    'soft (or zero) CTA',
    'short — read in <30 seconds',
  ],
  invariants: [
    { id: 'appreciative-tone', rule: 'Tone is appreciative, not promotional', kind: 'must_have' },
    { id: 'no-first-order-cta', rule: 'No "first order discount" — they\'re a customer', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
