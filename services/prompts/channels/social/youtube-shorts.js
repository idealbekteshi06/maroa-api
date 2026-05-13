'use strict';

/**
 * YouTube Shorts — vertical short-form, max 60s (90s in some 2025 regions).
 *
 * Sources: YouTube Creator Insider 2024-2025, MrBeast Shorts playbook,
 * Vidooly Shorts benchmark 2025.
 *
 * What performs:
 *   - 30-45s (Shorts sweet spot — long enough to deliver, short enough to
 *     replay)
 *   - Hook in first 1-2 seconds — text overlay or pattern interrupt
 *   - Loop-able (replays count separately from views in 2025 Shorts metric)
 *   - Tight pacing — no "intro music + welcome" filler
 *
 * What gets downranked:
 *   - Mid-roll filler ("hey guys, welcome back to my channel")
 *   - Re-uploaded TikTok with watermark
 *   - 16:9 landscape
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'youtube-shorts',
  name: 'YouTube Shorts',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'short_video',
  source_citation: 'YouTube Creator Insider + Vidooly Shorts Benchmark (2025)',
  channel_ids: ['youtube-shorts'],
  format_rules: {
    duration_sec: { min: 15, max: 60, ideal: 36 },
    aspect_ratio: '9:16',
    hook_window_sec: 2,
    captions: 'required',
    length_window: { min: 40, max: 150, ideal: 80 },
    cta_placement: 'last_3_sec',
  },
  hook_patterns: [
    { name: 'Visual hook', template: 'Striking visual in first frame', why: 'Shorts feed is ruthlessly visual' },
    { name: 'Number list', template: '"3 things about [topic]"', why: 'Finite list = high completion' },
    { name: 'Tutorial cold-open', template: 'Start mid-action, no intro', why: 'Skip the welcome ceremony' },
    { name: 'Stakes hook', template: '"I tried [thing]. Here\'s what happened."', why: 'Specific + finite' },
  ],
  anti_patterns: [
    { pattern: 'welcome back', why: 'Long-form intro — Shorts punishes' },
    { pattern: 'subscribe', why: 'CTA fatigue — leave to outro only' },
    { pattern: 'tiktok watermark', why: 'Cross-platform = deprioritized' },
  ],
  retention_mechanics: [
    'first 1-2 sec = hook',
    'cuts every 2-3 sec',
    'pattern interrupt at the 50% mark',
    'loop-able ending (replays = engagement)',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 2 sec must hook', kind: 'must_have' },
    { id: 'aspect-ratio', rule: '9:16 vertical', kind: 'must_have' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (_wordCount(first) > 8) {
      fixes.push({
        severity: 'block',
        issue: `YouTube Shorts: opening line ${_wordCount(first)} words — too long for 2-sec hook`,
        suggestion: 'Cut to ≤8 words.',
        span: null,
      });
    }
    return fixes;
  },
});
