'use strict';

/**
 * TikTok Ads — In-feed video ads, native-feeling.
 *
 * Sources: TikTok Ads Manager 2024-2025, TikTok Creative Center,
 * "Don't Make Ads — Make TikToks" creative principle (TikTok's own).
 *
 * What performs:
 *   - 9-16s in-feed ads (longer = drop-off, shorter = no impact)
 *   - Native-feeling (UGC > polished broadcast)
 *   - Hook in first 1-2s
 *   - Captions burned-in
 *   - Trending sound where appropriate
 *
 * What gets disapproved / underperforms:
 *   - Looks like a 30-sec TV ad (polished broadcast = poor performance)
 *   - Personal attributes ("you're overweight" style)
 *   - Misleading claims
 *   - Watermarks from other platforms
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'tiktok-ads',
  name: 'TikTok Ads',
  category: CHANNEL_CATEGORIES.PAID_ADS,
  surface_type: 'ad_video',
  source_citation: 'TikTok Ads Manager + Creative Center (2025)',
  channel_ids: ['tiktok-ads'],
  format_rules: {
    duration_sec: { min: 9, max: 30, ideal: 15 },
    aspect_ratio: '9:16',
    hook_window_sec: 2,
    captions: 'required',
    length_window: { min: 30, max: 150, ideal: 70 },
    cta_button: 'required',
  },
  hook_patterns: [
    {
      name: 'Native UGC',
      template: 'Creator-style POV with phone-camera feel',
      why: '"Don\'t make ads — make TikToks"',
    },
    {
      name: 'Problem snapshot',
      template: 'Specific visible problem in first second',
      why: 'Problem-aware hooks beat brand-aware',
    },
    {
      name: 'Stitch / trend leverage',
      template: 'Build on a current trend or sound',
      why: 'Borrowed reach from the trend',
    },
  ],
  anti_patterns: [
    { pattern: 'broadcast-style', why: 'TikTok punishes polished TV-ad feel' },
    { pattern: 'instagram watermark', why: 'Cross-platform watermark = disapproved' },
    { pattern: 'before and after', why: 'Body-transform — disapproved' },
  ],
  retention_mechanics: [
    'creator-style POV',
    'first 1-2 sec = hook',
    'use trending sound if licensed for ads',
    'captions burned-in',
    'CTA at end only',
  ],
  invariants: [
    { id: 'hook-window', rule: 'First 2 sec must hook', kind: 'must_have' },
    { id: 'native-feel', rule: 'Should feel like a TikTok, not a TV ad', kind: 'must_have' },
  ],
  manipulation_risk: 2,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (_wordCount(first) > 8) {
      fixes.push({
        severity: 'block',
        issue: `TikTok ad: opening line ${_wordCount(first)} words — too long for 2-sec hook`,
        suggestion: 'Cut to ≤8 words.',
        span: null,
      });
    }
    return fixes;
  },
});
