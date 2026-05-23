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

/**
 * Collect engagement-style signals from WF1 context bundle for hook ideation.
 */
function collectSignalsFromBundle(bundle) {
  const signals = [];
  const competitive = bundle?.competitive || {};
  for (const g of competitive.gapOpportunities || []) {
    if (g) signals.push({ source: 'competitor_gap', text: String(g), engagement_signal: 'competitive_intel' });
  }
  for (const w of competitive.whiteSpace || []) {
    if (w) signals.push({ source: 'white_space', text: String(w), engagement_signal: 'competitive_intel' });
  }
  for (const p of competitive.last24h || []) {
    if (p?.title || p?.headline) {
      signals.push({
        source: 'competitor_post',
        text: p.title || p.headline,
        engagement_signal: `eng=${p.engagement || p.estimatedEngagement || 0}`,
      });
    }
  }
  const audience = bundle?.audience || {};
  for (const c of audience.topComments48h || []) {
    if (c?.topic) {
      signals.push({
        source: 'audience_theme',
        text: c.topic,
        engagement_signal: `volume=${c.volume || 0}`,
      });
    }
  }
  const cultural = bundle?.cultural || {};
  for (const t of cultural.trendingTopics || cultural.localTrends || []) {
    if (typeof t === 'string') signals.push({ source: 'cultural', text: t, engagement_signal: 'local_trend' });
    else if (t?.topic) signals.push({ source: 'cultural', text: t.topic, engagement_signal: t.signal || 'trend' });
  }
  return signals;
}

/**
 * Append trending-hook guidance + bundle signals to WF1 strategic user prompt.
 */
function appendTrendingHooksToUserMessage(user, brandContext, bundle) {
  const signals = collectSignalsFromBundle(bundle);
  if (!signals.length) return user;
  const topic = [brandContext?.industry, brandContext?.businessName, brandContext?.country].filter(Boolean).join(' — ');
  const { user: signalBlock } = buildTrendingHooksPrompt({
    topic: topic || 'local business',
    signals,
    primaryLanguage: brandContext?.primaryLanguage || 'en',
  });
  return [
    user,
    '',
    '## Trending conversation signals (ground social hooks here — not generic topics)',
    'Use these real signals when writing concept hooks. Prefer tension from comments/competitor moves over invented trends.',
    '```json',
    signalBlock,
    '```',
  ].join('\n');
}

module.exports = {
  buildTrendingHooksPrompt,
  collectSignalsFromBundle,
  appendTrendingHooksToUserMessage,
};
