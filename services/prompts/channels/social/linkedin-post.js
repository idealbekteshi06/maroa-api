'use strict';

/**
 * LinkedIn feed post — text-first, professional context.
 *
 * Sources: LinkedIn Marketing Solutions research 2024-2025, Just/Nothing
 * LinkedIn analytics, Lara Acosta + Justin Welsh playbooks.
 *
 * What performs:
 *   - 150-300 words (long enough to be a "post", short enough to read fully)
 *   - Hook in line 1; ~210 chars visible before "see more"
 *   - Line breaks after every 1-2 sentences (mobile readability)
 *   - First-person, contrarian-but-not-troll, story-led
 *   - 0-5 hashtags (LinkedIn deprioritizes hashtag-stuffed posts)
 *   - No outbound links in main body — LinkedIn punishes; comments are OK
 *
 * What gets downranked:
 *   - "Buy now" / "DM me" / direct sales — flagged as promo
 *   - Hashtag stuffing (>5)
 *   - Repost engagement-baiting ("agree?", "thoughts?")
 *   - External links in body (drop in first comment instead)
 */

const { buildChannelModule, CHANNEL_CATEGORIES, _firstLine, _wordCount } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'linkedin-post',
  name: 'LinkedIn Post',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'LinkedIn Marketing Solutions + Welsh/Acosta playbooks (2025)',
  channel_ids: ['linkedin-post'],
  format_rules: {
    visible_caption_chars: 210,
    length_window: { min: 150, max: 300, ideal: 220 },
    hashtag_count: { min: 0, max: 5 },
    emoji_use: 'minimal',
    line_breaks: 'after every 1-2 sentences',
    cta_placement: 'comments',
    external_links: 'first_comment_only',
  },
  hook_patterns: [
    { name: 'Contrarian POV', template: '"Everyone\'s wrong about [X]. Here\'s why:"', why: 'POV opener = saves + shares' },
    { name: 'Story-led', template: '"I just [specific moment]. Here\'s what I learned:"', why: 'Narrative beats listicle on LinkedIn' },
    { name: 'Mistake confession', template: '"I lost $X by [specific mistake]. Here\'s what I should have done:"', why: 'Vulnerability + specificity' },
    { name: 'Counterintuitive data', template: '"[Specific stat] from this week says [counterintuitive insight]"', why: 'Data hooks LinkedIn power-users' },
  ],
  anti_patterns: [
    { pattern: 'buy now', why: 'LinkedIn flags as promo' },
    { pattern: 'sale', why: 'LinkedIn deprioritizes discount language' },
    { pattern: 'discount', why: 'LinkedIn deprioritizes discount language' },
    { pattern: 'dm me for', why: 'reads spammy in 2025' },
    { pattern: 'agree?', why: 'engagement bait — downranked' },
    { pattern: 'thoughts?', why: 'engagement bait — downranked' },
    { pattern: 'click the link', why: 'LinkedIn punishes outbound CTA in body' },
  ],
  retention_mechanics: [
    'hook in first line (210 chars visible before "see more")',
    'one thought per line, lots of whitespace',
    'first-person story or POV beats abstract advice',
    'CTA goes in the first comment (link too)',
    'reply to every comment in first 60 min (drives further distribution)',
  ],
  invariants: [
    { id: 'visible-hook', rule: 'First 210 chars must hook (only visible portion)', kind: 'must_have' },
    { id: 'no-promo-words', rule: 'No "buy now / sale / discount" in body', kind: 'must_avoid' },
    { id: 'no-engagement-bait', rule: 'No "agree?" / "thoughts?" tag-on', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    const first = _firstLine(draft);
    if (first.length > 210) {
      fixes.push({
        severity: 'suggest',
        issue: `LinkedIn: first line ${first.length} chars — only first 210 visible`,
        suggestion: 'Front-load the hook in first 210 chars.',
        span: null,
      });
    }
    if (_wordCount(draft) > 350) {
      fixes.push({
        severity: 'suggest',
        issue: `LinkedIn: ${_wordCount(draft)} words — beyond 300 word sweet spot`,
        suggestion: 'Trim to 220-280 words for max read-through.',
        span: null,
      });
    }
    return fixes;
  },
});
