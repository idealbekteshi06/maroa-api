'use strict';

/**
 * services/voc-scraper/index.js
 * ---------------------------------------------------------------------------
 * Voice-of-Customer extraction pipeline.
 *
 * Problem this solves: generic prompts produce generic content. The single
 * biggest output-quality lever is feeding the model the actual phrases real
 * customers use — not what Claude *thinks* customers say.
 *
 * Pipeline:
 *
 *   raw reviews (Google / Trustpilot / Yelp / G2 / competitor 1-stars)
 *           │
 *           ▼
 *   extractFromText() — Claude Haiku, structured-output prompt
 *           │
 *           ▼
 *   { love_phrases, pain_phrases, competitor_complaints, JTBD, ... }
 *           │
 *           ▼
 *   persistInsights() — writes rows to customer_insights table
 *           │
 *           ▼
 *   lib/groundingContext.js picks them up on next build (already wired)
 *
 * Why this design: it doesn't require any new tables, new code paths, or
 * grounding library changes. customer_insights is already read by
 * fetchVocThemes(). Adding rows = grounding gets smarter. Zero new wiring.
 *
 * The extraction is Haiku (cheap), the writes are bounded (max 12 phrases
 * per ingest), the failure mode is "skip this batch, log the error" —
 * grounding falls back to whatever was already in the table.
 *
 * Cost model per ingest run:
 *   - 1× Haiku call per ~50 reviews (~$0.002)
 *   - N inserts (free)
 *
 * Public API:
 *   extractFromText({ callClaude, reviewsText, competitorReviewsText? })
 *     → { love_phrases, pain_phrases, competitor_complaints, jtbd_phrases, trigger_events }
 *
 *   persistInsights({ sbPost, businessId, extracted })
 *     → { inserted: number }
 *
 *   ingestReviews({ callClaude, sbPost, businessId, reviewsText, competitorReviewsText?, logger? })
 *     → orchestrator: extract + persist
 * ---------------------------------------------------------------------------
 */

const MAX_PHRASES_PER_CATEGORY = 12;
const MAX_REVIEW_TEXT_CHARS = 25_000; // hard cap to keep Haiku input bounded

function _truncate(text, max = MAX_REVIEW_TEXT_CHARS) {
  if (!text) return '';
  const s = String(text).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function _buildExtractionSystemPrompt() {
  return `You are a senior direct-response copywriter trained in Voice-of-Customer analysis.

You will be shown raw customer reviews (and optionally competitor reviews).
Your job: extract the EXACT PHRASES customers use — verbatim, no paraphrasing.

These phrases will be fed back into ad copy + landing page hero text. They
MUST be real customer words. If you paraphrase, the ad sounds like every
other ad. The whole point is to use language the customer is already
saying out loud.

Output ONLY this JSON, no prose, no markdown fences:

{
  "love_phrases": ["exact phrase customers use when they LOVE the product"],
  "pain_phrases": ["exact phrase customers use when they describe the problem the product solves"],
  "competitor_complaints": ["exact phrase customers use when complaining about competitors (only if competitor reviews provided)"],
  "jtbd_phrases": ["short phrases that describe the job they're hiring the product to do"],
  "trigger_events": ["specific moments / situations that made them seek a solution"]
}

Rules:
- Max ${MAX_PHRASES_PER_CATEGORY} entries per category. Quality > quantity.
- Each phrase must be ≤ 12 words, lowercase, no punctuation other than apostrophes.
- NO paraphrasing. NO synthesis. If the review says "I was crying in the parking lot before I found this", extract "crying in the parking lot before I found this" — not "emotional moment before discovery".
- Deduplicate near-identical phrases (keep the most vivid one).
- Empty array is fine if no signal in that category.`;
}

/**
 * Parse the Claude output defensively. Returns null on parse failure so
 * caller can fall back to "skip this batch" without crashing.
 */
function parseExtractedVoc(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const categories = ['love_phrases', 'pain_phrases', 'competitor_complaints', 'jtbd_phrases', 'trigger_events'];
  const out = {};
  for (const cat of categories) {
    const arr = parsed[cat];
    if (!Array.isArray(arr)) {
      out[cat] = [];
      continue;
    }
    out[cat] = arr
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim().slice(0, 200))
      .slice(0, MAX_PHRASES_PER_CATEGORY);
  }
  // De-dupe across the love + pain categories — same phrase shouldn't
  // appear in both. Keep first occurrence.
  const seen = new Set();
  for (const cat of categories) {
    out[cat] = out[cat].filter((p) => {
      const k = p.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

/**
 * Single Haiku call to extract VoC structure from raw review text.
 * Returns the parsed structure or null on failure.
 */
async function extractFromText({ callClaude, reviewsText, competitorReviewsText, businessId, skill }) {
  if (!callClaude) throw new Error('voc-scraper.extractFromText: callClaude required');
  if (!reviewsText || typeof reviewsText !== 'string' || !reviewsText.trim()) {
    return null;
  }
  const system = _buildExtractionSystemPrompt();
  const user = [
    'REVIEWS OF THE BUSINESS:',
    _truncate(reviewsText),
    competitorReviewsText
      ? `\n\nCOMPETITOR REVIEWS (1–2 star, source of competitor_complaints):\n${_truncate(competitorReviewsText)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  let raw;
  try {
    raw = await callClaude({
      system,
      user,
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      extra: {
        businessId,
        skill: skill || 'voc_scraper_extract',
        skipBrandVoice: true,
        returnRaw: true,
      },
    });
  } catch {
    return null;
  }
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  return parseExtractedVoc(text);
}

/**
 * Write the extracted phrases into customer_insights as one row per
 * category. The grounding library's fetchVocThemes() picks them up
 * automatically — no schema changes needed.
 *
 * Each row uses insight_type that matches the category so grounding
 * can render them in the right slot of the prompt block.
 */
async function persistInsights({ sbPost, businessId, extracted, source = 'review_scrape' }) {
  if (!sbPost || !businessId || !extracted) return { inserted: 0 };
  const categories = {
    love_phrases: 'love_phrase',
    pain_phrases: 'pain_point',
    competitor_complaints: 'competitor_complaint',
    jtbd_phrases: 'jtbd',
    trigger_events: 'trigger_event',
  };
  let inserted = 0;
  for (const [field, insightType] of Object.entries(categories)) {
    const phrases = extracted[field] || [];
    if (!phrases.length) continue;
    // One row per category, with the phrases joined as actionable_suggestion.
    // The grounding library reads this as a single VoC entry per type.
    try {
      await sbPost('customer_insights', {
        user_id: businessId,
        source,
        insight_type: insightType,
        content: JSON.stringify({ phrases, extracted_at: new Date().toISOString() }),
        actionable_suggestion: phrases.slice(0, 6).join('; '),
      });
      inserted++;
    } catch {
      // Soft-fail per category — keep going
    }
  }
  return { inserted };
}

/**
 * Orchestrator: extract + persist in one call. Idempotent at the level of
 * "skip if extraction returned nothing" — won't insert empty rows.
 */
async function ingestReviews({
  callClaude,
  sbPost,
  businessId,
  reviewsText,
  competitorReviewsText,
  source = 'review_scrape',
  logger,
} = {}) {
  if (!businessId || !reviewsText) return { ok: false, reason: 'businessId + reviewsText required' };
  const extracted = await extractFromText({
    callClaude,
    reviewsText,
    competitorReviewsText,
    businessId,
    skill: 'voc_scraper_ingest',
  });
  if (!extracted) {
    logger?.warn?.('voc-scraper.ingest', businessId, 'extraction failed or empty', {
      hasCompetitor: !!competitorReviewsText,
    });
    return { ok: false, reason: 'extraction failed' };
  }
  const totalPhrases =
    extracted.love_phrases.length +
    extracted.pain_phrases.length +
    extracted.competitor_complaints.length +
    extracted.jtbd_phrases.length +
    extracted.trigger_events.length;
  if (totalPhrases === 0) {
    return { ok: true, reason: 'no signal in reviews', inserted: 0 };
  }
  const { inserted } = await persistInsights({ sbPost, businessId, extracted, source });
  logger?.info?.('voc-scraper.ingest', businessId, 'persisted', {
    inserted,
    totalPhrases,
    breakdown: {
      love: extracted.love_phrases.length,
      pain: extracted.pain_phrases.length,
      competitor: extracted.competitor_complaints.length,
      jtbd: extracted.jtbd_phrases.length,
      trigger: extracted.trigger_events.length,
    },
  });
  return { ok: true, inserted, totalPhrases, extracted };
}

module.exports = {
  ingestReviews,
  extractFromText,
  persistInsights,
  parseExtractedVoc,
  MAX_PHRASES_PER_CATEGORY,
};
