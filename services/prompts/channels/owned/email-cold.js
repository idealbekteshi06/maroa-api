'use strict';

/**
 * Cold email — outbound to a stranger, no prior relationship.
 *
 * Sources: Ali Schwanke + Justin Welsh cold-email playbooks 2025,
 * Lavender + Apollo cold-outbound benchmarks 2025.
 *
 * What performs:
 *   - Subject: 5-7 words, personalized, no spam triggers
 *   - First sentence: about THEM (not us), references a specific recent
 *     thing they did
 *   - Body: 50-90 words, 3-paragraph structure (relevance, value, ask)
 *   - One CTA — soft, low-commitment ask ("worth a 10-min call next week?")
 *
 * What gets sent to spam / unanswered:
 *   - "Hope this finds you well" / "Quick question" subject
 *   - "I wanted to" anywhere (writer-centric)
 *   - >120 words
 *   - Multiple CTAs
 *   - Image/HTML-heavy (looks like marketing, not 1:1)
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'email-cold',
  name: 'Cold Email',
  category: CHANNEL_CATEGORIES.OWNED,
  surface_type: 'email',
  source_citation: 'Lavender + Apollo cold-outbound benchmarks (2025)',
  channel_ids: ['email-cold'],
  format_rules: {
    subject_max_words: 7,
    length_window: { min: 50, max: 110, ideal: 70 },
    cta_count: 1,
    emoji_use: 'none',
    html: 'plain_text_preferred',
  },
  hook_patterns: [
    { name: 'Specific reference', template: 'Reference a specific thing they shipped/wrote/said', why: 'Proves the email is for them' },
    { name: 'Mutual connection', template: '"[Name] mentioned you\'re working on [thing]"', why: 'Highest open rate (referred)' },
    { name: 'Relevant compliment', template: 'One sentence about their work, then transition', why: 'Genuine + brief' },
  ],
  anti_patterns: [
    { pattern: 'hope this finds you well', why: 'Reads as template' },
    { pattern: 'quick question', why: 'Vague subject — low open rate' },
    { pattern: 'i wanted to', why: 'Writer-centric — switch to you-centric' },
    { pattern: 'circling back', why: 'Reads as bot follow-up' },
    { pattern: 'just checking in', why: 'No new value — gets ignored' },
    { pattern: 'click here', why: 'Generic CTA' },
  ],
  retention_mechanics: [
    'subject = personalized, 5-7 words',
    'first sentence about them, not you',
    '50-90 words total',
    'one soft CTA (no commitment ask)',
    'plain text, no images',
  ],
  invariants: [
    { id: 'word-limit', rule: '≤110 words body', kind: 'must_have' },
    { id: 'one-cta', rule: 'Single CTA only', kind: 'must_have' },
    { id: 'no-template-phrases', rule: 'No "hope this finds you well" / "circling back"', kind: 'must_avoid' },
  ],
  manipulation_risk: 2,
  applyExtras(draft) {
    const fixes = [];
    if (_wordCount(draft) > 120) {
      fixes.push({
        severity: 'block',
        issue: `Cold email: ${_wordCount(draft)} words — over 110 ceiling`,
        suggestion: 'Cut to 50-90 words. Open + value + ask. That\'s it.',
        span: null,
      });
    }
    return fixes;
  },
});
