'use strict';

/**
 * X (Twitter) post — short, single-thought, 280-char limit.
 *
 * Sources: X Creator Hub 2025, Naval/Justin Welsh/Sahil Bloom playbooks,
 * Buffer X benchmark 2025.
 *
 * What performs:
 *   - 50-200 chars (shorter = more re-posts; 280 max but optimal ~140)
 *   - One thesis per post (not a mini-blog)
 *   - Strong opening word (verbs, not articles)
 *   - Specific numbers + claims, no hedging
 *   - 0-2 hashtags (X devalues hashtags vs other platforms)
 *
 * What gets downranked:
 *   - Outbound links in the main post (X explicitly deprioritizes since
 *     2023 — drop in a reply instead)
 *   - Threading every post (mixed reception — only when it's actually a
 *     thread)
 *   - Engagement bait ("retweet if you agree")
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'x-post',
  name: 'X (Twitter) Post',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'X Creator Hub + Buffer X Benchmark (2025)',
  channel_ids: ['x-post'],
  format_rules: {
    max_chars: 280,
    length_window: { min: 8, max: 35, ideal: 18 }, // words
    max_words: 35,
    hashtag_count: { min: 0, max: 2 },
    emoji_use: 'minimal',
    external_links: 'reply_only',
  },
  hook_patterns: [
    { name: 'Thesis statement', template: 'One declarative sentence + colon + 2-3 supporting fragments', why: 'Best replied/re-posted shape' },
    { name: 'Hot take', template: 'Specific contrarian claim, no hedging', why: 'X rewards conviction over nuance' },
    { name: 'Numbered list (max 5)', template: 'Heading line + 1-5 numbered items, one line each', why: 'High save rate' },
    { name: 'Build-in-public', template: 'Specific metric + specific decision = relatable signal', why: 'Founder audience loves specificity' },
  ],
  anti_patterns: [
    { pattern: 'retweet if', why: 'engagement bait' },
    { pattern: 'agree?', why: 'engagement bait' },
    { pattern: 'thoughts?', why: 'engagement bait' },
    { pattern: 'check out the link', why: 'X deprioritizes outbound links in body' },
    { pattern: 'click my bio', why: 'reads spammy' },
  ],
  retention_mechanics: [
    'one thesis per post',
    'put the strongest claim in the first 10 words',
    'links go in a reply, not the main post',
    'don\'t end on a hedge ("maybe", "I think")',
  ],
  invariants: [
    { id: 'char-limit', rule: '≤280 chars', kind: 'must_have' },
    { id: 'one-thesis', rule: 'One single thought per post', kind: 'must_have' },
    { id: 'no-bait', rule: 'No "retweet if you agree" style', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    if (_wordCount(draft) > 35) {
      fixes.push({
        severity: 'block',
        issue: `X: ${_wordCount(draft)} words — over 35-word ceiling`,
        suggestion: 'Cut. Better: split into a thread.',
        span: null,
      });
    }
    return fixes;
  },
});
