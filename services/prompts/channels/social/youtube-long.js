'use strict';

/**
 * YouTube long-form video — 5-25 min, ranked by watch time + CTR.
 *
 * Sources: YouTube Creator Insider 2024-2025, MrBeast/Veritasium/Tubefilter
 * retention research.
 *
 * What performs:
 *   - 8-15 min runtime (rewards mid-roll ad slot AND deep watch time)
 *   - First 30 seconds = hook + thesis + payoff promise
 *   - Pattern interrupts every ~60-90s (new beat, location change, B-roll)
 *   - Title + thumbnail are the OR-gate — if either fails, nothing else
 *     matters
 *
 * What gets downranked:
 *   - "Don't forget to like and subscribe" in first 30s
 *   - Slow openers
 *   - Misleading thumbnail (clickbait that doesn't pay off → high
 *     unsubscribe rate → suppressed in feed)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'youtube-long',
  name: 'YouTube (long-form)',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'long_video',
  source_citation: 'YouTube Creator Insider + Veritasium/MrBeast retention research (2024-2025)',
  channel_ids: ['youtube-long'],
  format_rules: {
    duration_sec: { min: 300, max: 1500, ideal: 720 },
    aspect_ratio: '16:9',
    hook_window_sec: 30,
    title_max_chars: 60,
    description_length_window: { min: 200, max: 1500, ideal: 600 },
  },
  hook_patterns: [
    {
      name: 'Question + payoff promise',
      template: '"[Question]? In this video, I\'ll show you [outcome]."',
      why: 'Anchor the value within first 30s',
    },
    {
      name: 'Stakes hook',
      template: '"I spent $X / Y hours / Z attempts on this. Here\'s what I learned."',
      why: 'Stakes = watch-time',
    },
    {
      name: 'Counterintuitive thesis',
      template: 'Open with the contrarian finding, justify across the video',
      why: 'Hook viewers who would otherwise skip',
    },
  ],
  anti_patterns: [
    { pattern: "don't forget to like and subscribe", why: 'In first 30s = watch-time killer' },
    { pattern: "today we're going to", why: "Filler — show, don't announce" },
    { pattern: 'as you can see', why: 'Filler' },
  ],
  retention_mechanics: [
    'hook + thesis + payoff promise in first 30s',
    'pattern interrupt every 60-90s (B-roll, new location, cut)',
    'restate the goal at the midpoint',
    'pay off the hook explicitly at the end',
    'thumbnail and title are the OR-gate; spend 50% of effort there',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 30s = hook + payoff promise', kind: 'must_have' },
    { id: 'no-early-subscribe-ask', rule: 'No "like and subscribe" in first 30s', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
});
