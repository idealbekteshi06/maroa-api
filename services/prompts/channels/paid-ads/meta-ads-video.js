'use strict';

/**
 * Meta video ad — 9:16 or 1:1, runs across Reels, Feed, Stories.
 *
 * Sources: Meta Ads Manager + Meta Reels Ads playbook 2025, Motion video-ad
 * benchmark 2025.
 *
 * What performs:
 *   - 15-30s for Reels, 30-60s for Feed; 9:16 cross-placement
 *   - Hook in first 3 seconds — both visual and audio
 *   - Captions burned in (90% mobile, 60% mute)
 *   - Product or outcome visible in first frame
 *   - One CTA at the end (not mid-roll)
 *
 * What gets disapproved or downranked:
 *   - Personal-attribute language (same as image ads)
 *   - "Before/after" body or weight content
 *   - Misleading "story-time" with bait-and-switch
 *   - Slow openers (>3s without value visible)
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'meta-ads-video',
  name: 'Meta Video Ad',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_video',
  source_citation: 'Meta Ads Manager + Motion Video-Ad Benchmark (2025)',
  channel_ids: ['meta-ads-video'],
  format_rules: {
    duration_sec: { min: 15, max: 60, ideal: 24 },
    aspect_ratio: '9:16',
    hook_window_sec: 3,
    captions: 'required',
    length_window: { min: 30, max: 180, ideal: 70 },
    cta_button: 'required',
    cta_placement: 'last_3_sec',
  },
  hook_patterns: [
    { name: 'Problem in 3s', template: 'Specific visible problem on screen + agitating line', why: 'Pain-aware hooks beat brand-aware' },
    { name: 'Customer testimonial', template: 'Real customer on camera, 1-2 sentences', why: 'Native-feeling proof' },
    { name: 'Demo cold-open', template: 'Show the product solving the problem in first 3s', why: 'Outcome visible = scroll-stop' },
    { name: 'Pattern interrupt', template: 'Unusual visual or sound in first 1s', why: 'Breaks the feed pattern' },
  ],
  anti_patterns: [
    { pattern: 'you\'re overweight', why: 'Meta personal-attributes policy' },
    { pattern: 'before and after', why: 'Body-transform ads disapproved' },
    { pattern: 'guaranteed results', why: 'Absolute claim auto-flagged' },
    { pattern: 'as seen on tv', why: 'Vague authority — Meta low-quality flag' },
    { pattern: 'limited time only', why: 'Vague urgency' },
  ],
  retention_mechanics: [
    'first 3s = hook (visual + audio + caption)',
    'cuts every 2-3 sec',
    'product/outcome visible in first frame',
    'CTA in last 3 sec only',
    'captions burned in (mute-friendly)',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 3s must hook + show value', kind: 'must_have' },
    { id: 'captions', rule: 'Captions burned in', kind: 'must_have' },
    { id: 'no-personal-attributes', rule: 'No "you are [attribute]" phrasing', kind: 'must_avoid' },
  ],
  manipulation_risk: 2,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (_wordCount(first) > 10) {
      fixes.push({
        severity: 'suggest',
        issue: `Meta video ad: opening line ${_wordCount(first)} words — 3-sec hook ceiling is ~10 words`,
        suggestion: 'Cut opening line to ≤10 words.',
        span: null,
      });
    }
    return fixes;
  },
});
