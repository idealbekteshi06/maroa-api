'use strict';

/**
 * Threads post — Meta's text-first network, longer than X but shorter than
 * a LinkedIn post.
 *
 * Sources: Meta Newsroom (Threads launch + 2024-2025 product updates),
 * Buffer Threads benchmark 2025.
 *
 * What performs:
 *   - 50-200 chars (longer than X, shorter than LinkedIn)
 *   - Conversational, replies-first
 *   - Strong opening line — Threads feed shows first ~100 chars
 *   - Photo or video boost (text-only underperforms in 2025 algo)
 *
 * What gets downranked:
 *   - News/politics content (Meta explicitly deprioritizes since 2024)
 *   - Outbound links in body (drop in reply)
 *   - Cross-posted Twitter/X content with watermark
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'threads-post',
  name: 'Threads Post',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'Meta Newsroom + Buffer Threads Benchmark (2025)',
  channel_ids: ['threads-post'],
  format_rules: {
    max_chars: 500,
    length_window: { min: 50, max: 220, ideal: 110 },
    emoji_use: 'natural',
    media: 'photo_or_video_recommended',
    hashtag_count: { min: 0, max: 1 },
  },
  hook_patterns: [
    {
      name: 'Conversational opener',
      template: '"Hot take:" / "Real question:" / "Confession:"',
      why: 'Threads rewards casual + replies-bait shape',
    },
    { name: 'Specific detail', template: 'Specific number or moment + reflection', why: 'Specificity beats abstract' },
    { name: 'Single question', template: 'One genuine question to followers', why: 'Replies = distribution' },
  ],
  anti_patterns: [
    { pattern: 'click the link', why: 'Outbound links deprioritized' },
    { pattern: 'twitter', why: 'Cross-platform reference = downranked' },
  ],
  retention_mechanics: [
    'casual tone, lower-case ok',
    'add a photo or short video',
    'reply to your own post to extend (Threads-native pattern)',
  ],
  invariants: [{ id: 'char-limit', rule: '≤500 chars', kind: 'must_have' }],
  manipulation_risk: 1,
});
