'use strict';

/**
 * Instagram Stories — 24h ephemeral, 9:16, swipe-through.
 *
 * Sources: Instagram Creator Help (Stories), Buffer 2025 Stories report.
 *
 * What performs:
 *   - Frames that ask one thing (poll, slider, question sticker)
 *   - Series of 3-5 frames (one is too short, >7 loses retention)
 *   - Interactive stickers — polls, quizzes, sliders, questions
 *   - Direct, casual, in-the-moment tone
 *
 * What gets downranked / under-performs:
 *   - Polished broadcast-style frames (Stories punish over-production)
 *   - Single static frame with no interaction
 *   - Reposted feed posts as Stories
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'instagram-stories',
  name: 'Instagram Stories',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'story',
  source_citation: 'Instagram Creator Help + Buffer Stories Report (2025)',
  channel_ids: ['instagram-stories'],
  format_rules: {
    duration_sec: { min: 3, max: 60, ideal: 7 },
    aspect_ratio: '9:16',
    frame_count: { min: 3, max: 5 },
    interactive_sticker: 'recommended',
    emoji_use: 'natural',
    cta_placement: 'last_frame',
  },
  hook_patterns: [
    { name: 'Behind-the-scenes', template: 'Showing process, not just outcome', why: 'BTS earns DM replies' },
    { name: 'Poll', template: 'Two-option poll on a real opinion', why: 'Polls outperform static frames 4-7×' },
    {
      name: 'Question sticker',
      template: 'Ask audience for input on a real decision',
      why: 'Drives DMs + future content',
    },
    { name: 'Quiz/slider', template: 'Interactive sticker per frame', why: 'Stories rank by reply + interaction rate' },
  ],
  anti_patterns: [
    { pattern: 'over-edited', why: 'Stories punish broadcast aesthetic' },
    { pattern: 'silent frame', why: 'No sticker = no interaction = downranked' },
  ],
  retention_mechanics: [
    'one ask per frame (poll, slider, question)',
    '3-5 frames max per Story sequence',
    'casual selfie-cam tone, not broadcast',
    'use the question sticker — DMs are the Stories KPI',
  ],
  invariants: [
    { id: 'interactive', rule: 'At least one frame uses an interactive sticker', kind: 'must_have' },
    { id: 'aspect-ratio', rule: '9:16 vertical', kind: 'must_have' },
  ],
  manipulation_risk: 1,
});
