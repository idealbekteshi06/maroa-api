'use strict';

/**
 * Instagram Reels — short-form vertical video.
 *
 * Sources: Instagram Creator Help (Reels), MrBeast retention playbook
 * applied to short-form, Later 2025 short-video benchmark.
 *
 * What performs:
 *   - 7-30 seconds (Reels under 15s have highest completion rate as of 2025)
 *   - Hook in first 1-2 seconds — visual, audio, or text overlay
 *   - Captions burned-in (80% watch with sound off)
 *   - One idea per Reel — don't try to explain three things
 *   - Loop-able ending (drives replays, replays count as fresh views)
 *
 * What gets downranked:
 *   - Recycled TikToks with the TikTok watermark — Instagram explicitly
 *     deprioritizes
 *   - Slow openers
 *   - 16:9 landscape framing
 *   - >90s in 2025 (Reels max is 90s; longer = move to feed video)
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'instagram-reels',
  name: 'Instagram Reels',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'short_video',
  source_citation: 'Instagram Creator Help + Later short-video benchmark (2025)',
  channel_ids: ['instagram-reels'],
  format_rules: {
    duration_sec: { min: 7, max: 90, ideal: 21 },
    aspect_ratio: '9:16',
    hook_window_sec: 2,
    captions: 'required',
    text_overlay: 'recommended',
    length_window: { min: 30, max: 220, ideal: 80 },
    cta_placement: 'last_3_sec',
    hashtag_count: { min: 3, max: 7 },
    emoji_use: 'light',
  },
  hook_patterns: [
    {
      name: 'Pattern interrupt',
      template: "Visual or audio that doesn't match the expected feed flow",
      why: 'First 1-2 sec must break the scroll',
    },
    {
      name: 'Question hook',
      template: '"Why does [common thing] actually [counterintuitive outcome]?"',
      why: 'Curiosity gap → watch-time',
    },
    {
      name: 'Big number hook',
      template: '"I tried [thing] for 30 days. Here\'s what happened."',
      why: 'Specific + finite = completion-friendly',
    },
    {
      name: 'Contrarian opener',
      template: '"Everyone says [X]. They\'re wrong. Here\'s why:"',
      why: 'POV content out-saves explainer content',
    },
  ],
  anti_patterns: [
    { pattern: 'tiktok watermark', why: 'Instagram explicitly deprioritizes cross-posted TikToks' },
    { pattern: 'long intro', why: 'Loses 80% of viewers in first 3 sec' },
    { pattern: 'follow for more', why: 'engagement bait — downranked' },
  ],
  retention_mechanics: [
    'first 1-2 seconds = hook (visual + audio)',
    'cuts every 2-3 seconds',
    'pattern interrupt every ~10 seconds (new angle, new visual)',
    'loop-able ending (last frame matches first)',
    'captions burned in (mute-friendly)',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 2 seconds must earn the next 10', kind: 'must_have' },
    { id: 'captions', rule: 'Captions burned in (80% watch muted)', kind: 'must_have' },
    { id: 'aspect-ratio', rule: '9:16 vertical', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (_wordCount(first) > 8) {
      fixes.push({
        severity: 'block',
        issue: `Reels: opening line ${_wordCount(first)} words — too long for 2-sec hook`,
        suggestion: 'Cut opening line to ≤8 words. Hook + immediate stakes.',
        span: null,
      });
    }
    return fixes;
  },
});
