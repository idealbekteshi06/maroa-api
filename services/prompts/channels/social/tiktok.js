'use strict';

/**
 * TikTok — short-form vertical video, FYP-driven discovery.
 *
 * Sources: TikTok Creative Center + TikTok for Business research 2024-2025,
 * MrBeast retention playbook adapted to 7-60s.
 *
 * What performs:
 *   - 21-34s is the FYP sweet spot in 2025 (TikTok internal: completion rate
 *     × engagement product peaks there)
 *   - First-frame hook — visual, audio, text-overlay — must work muted
 *   - Native sound use (trending audio gets distribution boost)
 *   - Captions written for TikTok's caption window (cuts at ~80 chars on
 *     mobile)
 *
 * What gets downranked:
 *   - "Link in bio" — TikTok hides external links unless creator/business
 *   - Recycled vertical video with Instagram watermark
 *   - Slow openers (>2s before hook lands)
 *   - High-production polish that screams "ad"
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'tiktok',
  name: 'TikTok',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'short_video',
  source_citation: 'TikTok Creative Center + TikTok for Business (2025)',
  channel_ids: ['tiktok'],
  format_rules: {
    duration_sec: { min: 7, max: 60, ideal: 24 },
    aspect_ratio: '9:16',
    hook_window_sec: 2,
    captions: 'required',
    visible_caption_chars: 80,
    length_window: { min: 30, max: 180, ideal: 80 },
    hashtag_count: { min: 2, max: 5 },
    emoji_use: 'light',
  },
  hook_patterns: [
    {
      name: 'Stitch / duet hook',
      template: 'React-to or build-on existing trend',
      why: 'Borrowed reach from the original',
    },
    { name: 'POV hook', template: '"POV: you\'re [niche scenario]"', why: 'Niche POVs over-index in 2025 FYP' },
    { name: 'List tease', template: '"3 things I\'d do if I had to start over"', why: 'Finite list = high completion' },
    {
      name: 'Contrarian',
      template: '"Everyone tells you to [X]. I did the opposite. Here\'s what happened."',
      why: 'POV content out-performs explainer',
    },
    {
      name: 'Tutorial cold-open',
      template: 'Skip the intro — start mid-demo',
      why: 'No "welcome back to my channel" filler',
    },
  ],
  anti_patterns: [
    { pattern: 'link in bio', why: 'TikTok hides external links — confusing CTA' },
    { pattern: 'instagram watermark', why: 'Cross-platform watermark = downranked' },
    { pattern: 'welcome back', why: 'Reads as YouTube-style filler' },
    { pattern: 'follow for more', why: 'engagement bait' },
  ],
  retention_mechanics: [
    'first frame = hook (visual + audio + text)',
    'cuts every 1.5-2 seconds',
    'use trending sound (gets FYP boost)',
    'pattern interrupt every ~8 seconds',
    'loop-able ending',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 2 sec must hook', kind: 'must_have' },
    { id: 'captions', rule: 'Captions on (mute-friendly)', kind: 'must_have' },
    { id: 'aspect-ratio', rule: '9:16 vertical', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (_wordCount(first) > 8) {
      fixes.push({
        severity: 'block',
        issue: `TikTok: opening line ${_wordCount(first)} words — too long for 2-sec hook`,
        suggestion: 'Cut opener to ≤8 words.',
        span: null,
      });
    }
    return fixes;
  },
});
