'use strict';

/**
 * LinkedIn long-form article — 800-2000 words, byline-published.
 *
 * Sources: LinkedIn Marketing Solutions 2024, HubSpot LinkedIn content
 * report 2025.
 *
 * What performs:
 *   - 800-1800 words (LinkedIn article sweet spot)
 *   - H2/H3 section headers every ~300 words (scannable)
 *   - Strong title, contrarian or specific
 *   - Personal anecdote in first 2 paragraphs (otherwise reads as a blog)
 *   - One CTA at the end (mid-article CTAs underperform here)
 *
 * What gets downranked:
 *   - Pure SEO-style listicle (LinkedIn isn't Google — different audience)
 *   - >2500 words (drops read-through hard)
 *   - Zero personal voice
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'linkedin-article',
  name: 'LinkedIn Article',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'long_form',
  source_citation: 'LinkedIn Marketing Solutions + HubSpot LinkedIn Report (2025)',
  channel_ids: ['linkedin-article'],
  format_rules: {
    length_window: { min: 800, max: 1800, ideal: 1200 },
    headers_every_n_words: 300,
    cta_placement: 'end_only',
    hashtag_count: { min: 0, max: 3 },
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Specific number title', template: '"How we increased X by Y in Z months"', why: 'Specific titles get clicked' },
    { name: 'Contrarian title', template: '"Why [common practice] is killing your [goal]"', why: 'POV titles beat how-to titles on LinkedIn' },
    { name: 'Personal opener', template: 'Open with a specific moment, then zoom out to the lesson', why: 'Anecdote → insight is the LinkedIn article shape' },
  ],
  anti_patterns: [
    { pattern: 'in conclusion', why: 'Reads as a school essay' },
    { pattern: 'in this article', why: 'Filler — cut it' },
    { pattern: 'we will explore', why: 'Filler — show, don\'t announce' },
  ],
  retention_mechanics: [
    'H2 header every ~300 words',
    'one anecdote per major section',
    'one CTA at the very end',
    'personal voice — write it like the byline matters',
  ],
  invariants: [
    { id: 'word-window', rule: '800-1800 words', kind: 'must_have' },
    { id: 'personal-voice', rule: 'Anecdote or first-person moment in first 2 paragraphs', kind: 'must_have' },
  ],
  manipulation_risk: 1,
});
