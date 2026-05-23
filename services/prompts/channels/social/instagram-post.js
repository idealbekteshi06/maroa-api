'use strict';

/**
 * Instagram feed post — square/portrait image + caption.
 *
 * Sources: Instagram Creator Help 2024-2026, Buffer + Later annual report,
 * Hootsuite content benchmarks 2025.
 *
 * What performs:
 *   - Caption opens with a hook in the first line (only ~125 chars visible
 *     before "more" — see format_rules)
 *   - Mid-length caption (70-150 words) — too short reads like spam, too
 *     long doesn't get expanded
 *   - 3-10 hashtags, mixed niche + broad
 *   - Save-worthy or share-worthy framing (saves outweigh likes in 2025
 *     ranking)
 *
 * What gets downranked:
 *   - "Buy now" / "swipe up" / direct sales in caption (the platform's
 *     anti-spam filter)
 *   - All-caps first line
 *   - >10 hashtags packed in caption (move to first comment instead)
 */

const { buildChannelModule, CHANNEL_CATEGORIES } = require('../_helpers');

module.exports = buildChannelModule({
  id: 'instagram-post',
  name: 'Instagram Post',
  category: CHANNEL_CATEGORIES.SOCIAL,
  surface_type: 'feed_post',
  source_citation: 'Instagram Creator Help + Buffer Annual Report (2025)',
  channel_ids: ['instagram-post'],
  format_rules: {
    visible_caption_chars: 125,
    length_window: { min: 70, max: 220, ideal: 130 },
    hashtag_count: { min: 3, max: 10 },
    emoji_use: 'light',
    line_breaks: 'after every 1-2 sentences (mobile scannable)',
    cta_placement: 'last_line',
  },
  hook_patterns: [
    {
      name: 'Curiosity gap',
      template: 'This is the thing nobody told me about [topic] →',
      why: 'Forces the "more" tap',
    },
    {
      name: 'Contrarian POV',
      template: "Stop doing [common advice]. Here's what actually works:",
      why: 'Saves + shares spike on POV posts',
    },
    {
      name: 'Number tease',
      template: '5 things I wish I knew before [thing]:',
      why: 'Listicle openers earn the swipe to comments',
    },
    {
      name: 'Confession',
      template: "I was wrong about [topic]. Here's what I learned:",
      why: 'Vulnerability outperforms expertise-posing',
    },
  ],
  anti_patterns: [
    { pattern: 'buy now', why: 'flagged as spammy in caption' },
    { pattern: 'link in bio', why: 'overused — platform deprioritizes' },
    { pattern: 'tag a friend who', why: 'engagement-bait — downranked since 2018' },
    { pattern: 'swipe up', why: 'Stories-only mechanic; reads as confused' },
    { pattern: '#follow4follow', why: 'spam signal' },
  ],
  retention_mechanics: [
    'first line visible before "more" — make it earn the tap',
    'one thought per line (scannable on mobile)',
    'CTA is the last line, not the first',
    'use saves/shares as the goal metric, not likes',
  ],
  invariants: [
    { id: 'visible-hook', rule: 'First 125 chars must hook (only visible portion)', kind: 'must_have' },
    { id: 'no-engagement-bait', rule: 'No "tag a friend who" or similar', kind: 'must_avoid' },
  ],
  manipulation_risk: 1,
  applyExtras(draft) {
    const fixes = [];
    const firstLine = String(draft).split(/\n/)[0] || '';
    if (firstLine.length > 200 && !firstLine.includes('.')) {
      fixes.push({
        severity: 'suggest',
        issue: "Instagram: first line >200 chars without punctuation — won't fit the visible window",
        suggestion: 'Front-load the hook in the first 125 chars (before "more" cuts in).',
        span: null,
      });
    }
    if (/^[A-Z\s!?]{20,}$/.test(firstLine.trim())) {
      fixes.push({
        severity: 'suggest',
        issue: 'Instagram: all-caps opener reads as spam',
        suggestion: 'Mixed case with one strong word in caps if you need emphasis.',
        span: null,
      });
    }
    return fixes;
  },
});
