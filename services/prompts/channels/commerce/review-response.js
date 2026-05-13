'use strict';

/**
 * Review response — replies to Google, Yelp, Trustpilot, app store reviews.
 *
 * Sources: Google Business Profile Help + BrightLocal local-SEO research
 * 2025.
 *
 * What performs:
 *   - Respond within 24h (top performers respond within 8h)
 *   - Address reviewer by first name
 *   - Acknowledge specific detail they mentioned
 *   - For negative: empathize → context → resolution (NEVER defensive)
 *   - 30-80 words — long enough to feel sincere, short enough to read
 *
 * What damages reputation:
 *   - Copy-paste boilerplate reply across all reviews
 *   - Defensive tone on negative reviews
 *   - Public legal threats
 *   - Asking to "take it offline" without first addressing
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'review-response',
  name: 'Review Response',
  category: CHANNEL_CATEGORIES.COMMERCE,
  surface_type: 'message',
  source_citation: 'Google Business Profile + BrightLocal Local SEO (2025)',
  channel_ids: ['review-response'],
  format_rules: {
    length_window: { min: 30, max: 100, ideal: 55 },
    sla_hours: 24,
    emoji_use: 'minimal',
    tone: 'specific_human',
  },
  hook_patterns: [
    { name: 'Specific acknowledgment', template: '"Thanks, [Name] — glad [specific thing they mentioned] worked for you."', why: 'Proves the reply is for them' },
    { name: 'Negative-handling', template: 'Empathize → context → resolution offer + contact', why: 'Defuses defensiveness' },
    { name: 'Local touch', template: 'Reference local context if relevant (event, neighborhood)', why: 'Local SEO + authentic feel' },
  ],
  anti_patterns: [
    { pattern: 'we appreciate your feedback', why: 'Boilerplate — kills authenticity' },
    { pattern: 'thank you for your business', why: 'Boilerplate' },
    { pattern: 'please take this offline', why: 'Reads dismissive — address first' },
    { pattern: 'this is not our experience', why: 'Defensive — never works' },
  ],
  retention_mechanics: [
    'respond within 24h',
    'address by first name',
    'acknowledge specific detail',
    'for negative: empathize → context → resolution',
    '30-80 words',
  ],
  invariants: [
    { id: 'specific-detail', rule: 'Reference a specific thing the reviewer mentioned', kind: 'must_have' },
    { id: 'no-boilerplate', rule: 'No "we appreciate your feedback" template', kind: 'must_avoid' },
    { id: 'no-defensive', rule: 'No defensive language on negative reviews', kind: 'must_avoid' },
  ],
  manipulation_risk: 0,
  applyExtras(draft) {
    const fixes = [];
    if (_wordCount(draft) > 120) {
      fixes.push({
        severity: 'suggest',
        issue: `Review response: ${_wordCount(draft)} words — over 100 ceiling`,
        suggestion: 'Cut to 30-80 words. Specific + sincere beats long.',
        span: null,
      });
    }
    return fixes;
  },
});
