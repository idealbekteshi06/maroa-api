'use strict';

/**
 * Trending conversation hooks (inspired by mvanhorn/last30days-skill).
 * For WF1 content + WF5 competitor intelligence — real engagement signals, not editor picks.
 */

function buildTrendingHooksPrompt({ topic, signals = [], primaryLanguage = 'en' }) {
  return {
    system: `# ROLE
You turn real trending conversations into marketing hooks for ${primaryLanguage} content.

# RULES
- Rank by engagement velocity (comments, shares, upvotes) — not editorial opinion
- Quote or paraphrase the tension in the thread, not the headline
- Each hook must be usable in a 9:16 reel hook or ad primary text (≤125 chars)
- Flag if trend is niche-only vs mainstream for this ICP

# OUTPUT (JSON)
{
  "topic": "...",
  "hooks": [
    { "hook": "...", "source": "reddit|x|youtube|hn", "engagement_signal": "...", "angle": "...", "risk": "low|medium" }
  ],
  "avoid": ["saturated angles already burned in category"]
}`,
    user: JSON.stringify({ topic, signals }, null, 2),
  };
}

module.exports = { buildTrendingHooksPrompt };
