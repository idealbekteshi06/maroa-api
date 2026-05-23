'use strict';

/**
 * Podcast script — solo or interview, 20-60 min.
 *
 * Sources: Pat Flynn + Tim Ferriss + Joe Rogan production patterns,
 * Edison Research podcast listening data 2025.
 *
 * What performs:
 *   - Hook in first 30-60 seconds (most podcast drop-off happens here)
 *   - Tease the payoff before the intro music
 *   - Interview: prep specific questions, not generic "tell me about
 *     yourself"
 *   - One key takeaway repeated at intro + mid + outro
 *
 * What underperforms:
 *   - Long intro before any content
 *   - Generic interview questions
 *   - Multi-topic episode without a through-line
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'podcast-script',
  name: 'Podcast Script',
  category: CHANNEL_CATEGORIES.WEB,
  surface_type: 'long_form',
  source_citation: 'Pat Flynn + Edison Research Podcast Data (2025)',
  channel_ids: ['podcast-script'],
  format_rules: {
    duration_min: { min: 20, max: 90, ideal: 45 },
    length_window: { min: 2500, max: 8000, ideal: 5000 },
    hook_window_sec: 60,
  },
  hook_patterns: [
    {
      name: 'Tease payoff',
      template: 'In first 30s, name the most surprising thing the episode covers',
      why: 'Beats drop-off',
    },
    {
      name: 'Cold open quote',
      template: 'Strong quote from guest before intro music',
      why: 'Pulls listeners through the intro',
    },
    {
      name: 'Question hook',
      template: '"In this episode, you\'ll learn the answer to [specific question]"',
      why: 'Anchors value',
    },
  ],
  anti_patterns: [
    { pattern: 'welcome to the show', why: 'Skip the welcome — start with value' },
    { pattern: 'tell me about yourself', why: 'Generic — show prep' },
  ],
  retention_mechanics: [
    'hook in first 30-60s',
    'tease the payoff before intro music',
    'one key takeaway repeated',
    'chapters/timestamps in show notes',
  ],
  invariants: [{ id: 'hook-window', rule: 'First 60s hooks the listener', kind: 'must_have' }],
  manipulation_risk: 0,
});
