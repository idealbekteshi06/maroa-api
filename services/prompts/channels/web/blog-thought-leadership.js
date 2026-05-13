'use strict';

/**
 * Thought leadership blog post — opinion + insight, not SEO-led.
 *
 * Sources: Edelman Trust Barometer 2025, First Round Review playbook,
 * Andreessen Horowitz + Stratechery editorial patterns.
 *
 * What performs:
 *   - 1000-2500 words
 *   - Strong POV in title and first paragraph
 *   - Original argument backed by specific evidence (not "thought-leader
 *     hot take")
 *   - One core thesis, supported by 3-5 sub-points
 *   - Clear takeaway / so-what
 *
 * What underperforms:
 *   - Hedging language ("could be", "might consider")
 *   - Generic industry-trend recap without POV
 *   - Buzzword-led intro
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'blog-thought-leadership',
  name: 'Blog (Thought Leadership)',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'long_form',
  source_citation: 'First Round Review + Stratechery editorial patterns (2025)',
  channel_ids: ['blog-thought-leadership'],
  format_rules: {
    length_window: { min: 800, max: 2500, ideal: 1400 },
    pov_required: true,
    emoji_use: 'none',
  },
  hook_patterns: [
    { name: 'Contrarian thesis', template: 'Open with the counter-consensus claim, support across the post', why: 'POV beats summary' },
    { name: 'Specific moment', template: '"Last week I [specific moment]. Here\'s what I learned about [larger lesson]:"', why: 'Story → insight is the shape' },
    { name: 'Data + insight', template: 'Lead with original data, then the contrarian interpretation', why: 'Data + POV = high credibility' },
  ],
  anti_patterns: [
    { pattern: 'in today\'s rapidly evolving', why: 'AI-tell phrase' },
    { pattern: 'thought leader', why: 'Self-anointing — Critic flag' },
    { pattern: 'unprecedented times', why: 'Cliché' },
    { pattern: 'navigate the complexity', why: 'AI-tell phrase' },
  ],
  retention_mechanics: [
    'strong POV in title + first paragraph',
    'one core thesis, 3-5 sub-points',
    'specific evidence — not abstract trend talk',
    'clear takeaway / so-what at the end',
  ],
  invariants: [
    { id: 'pov-required', rule: 'Must have a clear point of view, not summary', kind: 'must_have' },
    { id: 'no-hedging', rule: 'No "could", "might", "perhaps" weak hedges in thesis', kind: 'must_avoid' },
  ],
  manipulation_risk: 0,
});
