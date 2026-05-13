'use strict';

/**
 * Feed-Native Laws — channel-specific defaults.
 *
 * The observation: writing the SAME post for Instagram, LinkedIn, X,
 * and TikTok and just cross-posting it underperforms each channel\'s
 * native shape. Each surface has implicit "feed laws" — punctuation,
 * pacing, openings, line breaks — that locals recognize.
 *
 * Source: industry consensus (Buffer, Sprout Social, Later research
 * 2018–present).
 *
 * Manipulation_risk = 1.
 */

const { _wordCount, makeFix, applicability } = require('../_helpers');

const CHANNEL_LAWS = {
  'instagram-post': {
    line_break_after_n: 1, // line break after each thought
    emoji_use: 'light',
    hashtag_count: { min: 3, max: 10 },
    opening_pattern: 'curiosity / question / contrarian',
  },
  'linkedin-post': {
    line_break_after_n: 1,
    emoji_use: 'minimal',
    hashtag_count: { min: 0, max: 5 },
    opening_pattern: 'POV statement / counter-intuitive claim',
    avoid: ['buy now', 'sale', 'discount'],
  },
  'x-post': {
    max_words: 35,
    emoji_use: 'minimal',
    hashtag_count: { min: 0, max: 2 },
    opening_pattern: 'thesis statement / hot take',
  },
  tiktok: {
    line_break_after_n: 1,
    emoji_use: 'light',
    hashtag_count: { min: 2, max: 5 },
    opening_pattern: 'first 3 seconds = hook',
  },
};

function applyToDraft(draft, context = {}) {
  if (!draft) return { score: 0, fixes: [], reasoning: 'empty draft' };
  const laws = CHANNEL_LAWS[context.channel];
  if (!laws) return { score: 0.7, fixes: [], reasoning: 'no channel-specific law applies' };

  const fixes = [];
  const wc = _wordCount(draft);
  if (laws.max_words && wc > laws.max_words) {
    fixes.push(
      makeFix({
        severity: 'block',
        issue: `Feed-native (${context.channel}): ${wc} words exceeds max ${laws.max_words}`,
        suggestion: `Cut to ≤${laws.max_words} words.`,
      })
    );
  }
  if (laws.avoid) {
    const violations = laws.avoid.filter((p) => draft.toLowerCase().includes(p));
    if (violations.length) {
      fixes.push(
        makeFix({
          severity: 'suggest',
          issue: `Feed-native (${context.channel}): contains phrases punished on this channel: ${violations.join(', ')}`,
          suggestion: 'Reframe — these phrases get downranked or hidden by the platform.',
        })
      );
    }
  }
  return { score: fixes.length === 0 ? 1.0 : 0.4, fixes, reasoning: `channel=${context.channel} wc=${wc}` };
}

function generateFromSpec({ channel }) {
  const laws = CHANNEL_LAWS[channel];
  if (!laws) {
    return { structure: 'no channel-specific law', prompt_segments: [] };
  }
  return {
    structure: `Feed-native laws for ${channel}`,
    prompt_segments: [
      `OPENING: ${laws.opening_pattern}.`,
      laws.max_words ? `MAX WORDS: ${laws.max_words}.` : '',
      laws.line_break_after_n ? `LINE BREAKS: after each thought (scannable on mobile).` : '',
      laws.emoji_use ? `EMOJI: ${laws.emoji_use}.` : '',
      laws.hashtag_count ? `HASHTAGS: ${laws.hashtag_count.min}-${laws.hashtag_count.max}.` : '',
      laws.avoid ? `AVOID: ${laws.avoid.join(', ')} (downranked on this channel).` : '',
    ].filter(Boolean),
  };
}

module.exports = {
  id: 'feed-native-laws',
  name: 'Feed-Native Laws',
  category: 'modern',
  source_citation: 'Buffer + Sprout Social + Later research consensus (2018+)',
  applicability: applicability({ channels: ['instagram-post', 'linkedin-post', 'x-post', 'tiktok', 'threads-post'] }),
  invariants: [{ id: 'channel-shape', rule: 'Content must respect channel-specific shape', kind: 'must_have' }],
  manipulation_risk: 1,
  CHANNEL_LAWS,
  applyToDraft,
  generateFromSpec,
};
