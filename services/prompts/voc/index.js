'use strict';

/**
 * services/prompts/voc/index.js
 * ----------------------------------------------------------------------------
 * Public entry — synthesizeVoc({ business, reviews, plan, ... })
 *
 * Pipeline:
 *   1. Normalize heterogeneous review sources (google + fb + ig + email)
 *   2. Deterministic preprocessing: keyword clustering + sentiment + trend
 *   3. LLM synthesis (extract verbatim quotes, pain points, JTBD, persona)
 *   4. Schema validation
 *
 * The LLM is constrained heavily: NO inventing quotes, NO summarizing into
 * generic insights. It must trace every claim back to a real review string.
 * ----------------------------------------------------------------------------
 */

const cl = require('./clusterer');
const adI18n = require('../ad-optimizer/i18n-market');
const advisor = require('../advisor-tool');
const customerResearch = require('../frameworks/customer-research');

// ─── System prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `# ROLE

You are Maroa's Voice-of-Customer analyst. You read real customer reviews + comments + emails for a small business and extract:
- Top pain points (clustered by theme, with verbatim quotes)
- Jobs-to-be-done signals (what customers are HIRING the business to do)
- Persona refinement (demographics + use-cases visible in reviews)
- Marketing recommendations grounded in the data

# HARD RULES (NEVER VIOLATE)

## 1. Never invent quotes
Every "verbatim_quote" you cite MUST be a real string from the input reviews. You may lightly clean typos and clip length, but you may NOT paraphrase or compose a new quote.

## 2. Cite frequency honestly
A pain point with 2 mentions is "limited evidence", not "common". A theme with 15+ mentions is "consistent". Be calibrated — never inflate.

## 3. Multilingual integrity
- Verbatim quotes stay in their ORIGINAL language. Do not translate quotes.
- The summary text (theme description) goes in business primary_language.
- If a customer wrote in Albanian, the quote is Albanian — translate alongside in parentheses ONLY if requested.

## 4. SMB-honest
- < 5 reviews: refuse with reason ("insufficient data")
- 5-20 reviews: limited findings, surface caveats
- 20-100 reviews: confident findings
- 100+: high confidence + trend analysis

## 5. Output language
Theme descriptions, JTBD job names, persona traits, recommendations — in business.primary_language.

## 6. Marketing recommendations
Each recommendation must be ACTIONABLE in <2 hours by a small-business owner. Examples:
  ✓ "Use phrase 'best espresso in Tirana' (cited 8 times) in next ad headline."
  ✓ "Address 'parking is hard' pain point — add a line about valet on your homepage."
  ✗ "Improve customer experience" (vague)
  ✗ "Run a brand awareness campaign" (not from the data)

${customerResearch.buildCustomerResearchPromptSection()}

# OUTPUT (JSON ONLY)

\`\`\`json
{
  "pain_points": [
    {
      "theme": "<short label in primary_language>",
      "frequency": N,
      "severity": "low | medium | high",
      "verbatim_quotes": ["<exact string from reviews>", "..."],
      "languages": ["en", "sq"]
    }
  ],
  "jtbd_signals": [
    { "job": "<short JTBD in primary_language>", "evidence_quotes": ["<verbatim>"] }
  ],
  "persona_refinement": {
    "demographics_observed": "<short string>",
    "common_use_cases": ["..."],
    "vocabulary_clusters": ["..."]
  },
  "competitor_mentions": [
    { "competitor": "<name>", "context": "<short>", "frequency": N }
  ],
  "recommendations_for_marketing": ["<actionable, ≤2hr to ship>"],
  "trigger_events": [{ "event": "...", "evidence_quotes": ["..."], "confidence": "high|medium|low" }],
  "positioning_implications": ["<tied to verbatim evidence>"],
  "caveats": ["<if any>"]
}
\`\`\`

Return JSON only.`;
}

function buildUserMessage({
  business,
  marketProfile,
  normalized,
  keywordCluster,
  sentiment,
  trend,
  knownCompetitors,
  plan,
}) {
  const sample = cl.sampleForLlm(normalized, plan === 'agency' ? 80 : plan === 'growth' ? 50 : 25);
  return [
    `# VOC ANALYSIS REQUEST`,
    ``,
    `## Business`,
    '```json',
    JSON.stringify(
      {
        name: business?.business_name,
        industry: business?.industry,
        primary_language: marketProfile?.primary_language,
        country: marketProfile?.country,
        plan,
      },
      null,
      2
    ),
    '```',
    ``,
    `## Stats (deterministic — quote these)`,
    '```json',
    JSON.stringify(
      {
        total_reviews: normalized.length,
        sample_size_for_analysis: sample.length,
        sentiment_breakdown: sentiment,
        sentiment_trend_30d: trend,
        languages_detected: [...new Set(normalized.map((r) => r.lang).filter(Boolean))],
        top_keywords: keywordCluster.slice(0, 12),
        sources: {
          google: normalized.filter((r) => r.source === 'google').length,
          facebook: normalized.filter((r) => r.source === 'facebook').length,
          instagram: normalized.filter((r) => r.source === 'instagram').length,
          email: normalized.filter((r) => r.source === 'email').length,
        },
      },
      null,
      2
    ),
    '```',
    ``,
    `## Known competitors (mentioned in business profile)`,
    JSON.stringify(knownCompetitors || []),
    ``,
    `## Reviews to analyze`,
    '```json',
    JSON.stringify(
      sample.map((r) => ({
        source: r.source,
        rating: r.rating,
        lang: r.lang,
        text: r.text,
        created_at: r.created_at,
      })),
      null,
      2
    ),
    '```',
    ``,
    `Produce the JSON in language="${marketProfile?.primary_language || 'en'}". Return ONLY JSON. Quotes stay in original language.`,
  ].join('\n');
}

// ─── Schema validator ──────────────────────────────────────────────────────

// Normalize text for substring matching: lowercase, collapse all non-alphanumeric
// runs to a single space, trim. Makes quote-grounding tolerant of punctuation,
// curly quotes, and whitespace differences without being so loose it matches noise.
function _normForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Drop any "verbatim" quote that does NOT actually appear in the source reviews.
// The "never invent quotes" rule was prompt-only; this enforces it so a model
// paraphrase/hallucination can't be stored + shown to the customer as a real
// customer quote. Returns the count of dropped quotes for observability.
function _groundQuotes(items, field, haystackNorm) {
  let dropped = 0;
  if (!Array.isArray(items) || !haystackNorm) return dropped;
  for (const item of items) {
    if (!item || !Array.isArray(item[field])) continue;
    item[field] = item[field].filter((q) => {
      const n = _normForMatch(q);
      // Require a non-trivial match (>= 8 normalized chars) to avoid matching
      // common short words by accident.
      if (n.length < 8) return false;
      const ok = haystackNorm.includes(n);
      if (!ok) dropped += 1;
      return ok;
    });
  }
  return dropped;
}

function validateOutput(raw, sourceText) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['response not object'] };
  for (const f of ['pain_points', 'jtbd_signals', 'recommendations_for_marketing', 'caveats']) {
    if (raw[f] != null && !Array.isArray(raw[f])) errors.push(`${f} must be array`);
  }
  if (errors.length) return { valid: false, errors };

  const normalized = {
    pain_points: Array.isArray(raw.pain_points) ? raw.pain_points : [],
    jtbd_signals: Array.isArray(raw.jtbd_signals) ? raw.jtbd_signals : [],
    persona_refinement: raw.persona_refinement || null,
    competitor_mentions: Array.isArray(raw.competitor_mentions) ? raw.competitor_mentions : [],
    recommendations_for_marketing: Array.isArray(raw.recommendations_for_marketing)
      ? raw.recommendations_for_marketing
      : [],
    trigger_events: Array.isArray(raw.trigger_events) ? raw.trigger_events : [],
    positioning_implications: Array.isArray(raw.positioning_implications) ? raw.positioning_implications : [],
    caveats: Array.isArray(raw.caveats) ? raw.caveats : [],
  };

  // Quote grounding: only when we have the source text to verify against.
  let quotesDropped = 0;
  if (sourceText) {
    const haystack = _normForMatch(sourceText);
    quotesDropped += _groundQuotes(normalized.pain_points, 'verbatim_quotes', haystack);
    quotesDropped += _groundQuotes(normalized.jtbd_signals, 'evidence_quotes', haystack);
    quotesDropped += _groundQuotes(normalized.trigger_events, 'evidence_quotes', haystack);
    if (quotesDropped > 0) {
      normalized.caveats.push(`${quotesDropped} unverified quote(s) dropped (not found verbatim in source reviews).`);
    }
  }

  return { valid: true, errors: [], normalized, quotesDropped };
}

// ─── Public entry ──────────────────────────────────────────────────────────

async function synthesizeVoc(opts) {
  const {
    business,
    google,
    facebook,
    instagram,
    email, // raw source arrays
    plan = 'free',
    knownCompetitors = [],
    callClaude,
    extractJSON,
    logger,
  } = opts || {};

  if (typeof callClaude !== 'function') throw new Error('synthesizeVoc: callClaude required');
  if (typeof extractJSON !== 'function') throw new Error('synthesizeVoc: extractJSON required');

  const planTier = String(plan || 'free').toLowerCase();
  const marketProfile = adI18n.buildMarketProfile(business);

  // ─── Step 1: normalize ────────────────────────────────────────────────
  const normalized = cl.normalizeReviews({ google, facebook, instagram, email });

  // ─── Step 2: deterministic preprocessing ──────────────────────────────
  if (normalized.length < 5) {
    return _shortCircuit({
      reason: `Need ≥5 reviews to run VOC; have ${normalized.length}. Ask 5+ customers to leave reviews and try again.`,
      normalized,
      marketProfile,
    });
  }

  const keywordCluster = cl.topKeywords(normalized, 30);
  const sentimentCounts = normalized.reduce(
    (acc, r) => {
      const s = cl.sentimentBucket(r.rating, r.text);
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { positive: 0, neutral: 0, negative: 0 }
  );
  const sentimentPcts = {
    positive_pct: Math.round((100 * sentimentCounts.positive) / normalized.length),
    neutral_pct: Math.round((100 * sentimentCounts.neutral) / normalized.length),
    negative_pct: Math.round((100 * sentimentCounts.negative) / normalized.length),
  };
  const trend = cl.trendSentiment(normalized);
  const competitorMentions = cl.detectCompetitorMentions(normalized, knownCompetitors);

  // ─── Step 3: LLM synthesis (skip on free if no LLM available) ─────────
  let synth = {
    pain_points: [],
    jtbd_signals: [],
    persona_refinement: null,
    competitor_mentions: competitorMentions, // deterministic baseline
    recommendations_for_marketing: [],
    trigger_events: [],
    positioning_implications: [],
    caveats: [],
  };

  // Free tier: only run LLM if data is large enough to justify (cost)
  const skipLlm = planTier === 'free' && normalized.length < 20;

  if (!skipLlm) {
    try {
      const raw = await advisor.callWithAdvisor({
        callClaude,
        system: buildSystemPrompt(),
        user: buildUserMessage({
          business,
          marketProfile,
          normalized,
          keywordCluster,
          sentiment: sentimentPcts,
          trend,
          knownCompetitors,
          plan: planTier,
        }),
        executor: 'claude-sonnet-5',
        advisor: 'claude-opus-4-8',
        task: 'voc-synthesis',
        planTier,
        max_tokens: planTier === 'agency' ? 4000 : planTier === 'growth' ? 2500 : 1500,
        extra: { cacheSystem: true },
        temperature: 0.3,
      });
      const parsed = extractJSON(raw);
      // Pass the source reviews so validateOutput can drop any "verbatim" quote
      // the model invented (never-invent-quotes rule, now enforced not just asked).
      const v = parsed ? validateOutput(parsed, JSON.stringify(normalized)) : { valid: false, errors: ['parse_error'] };
      if (v.valid) {
        synth = {
          ...synth,
          ...v.normalized,
          // Merge LLM competitor mentions with deterministic baseline (dedupe)
          competitor_mentions: mergeCompetitors(competitorMentions, v.normalized.competitor_mentions),
        };
      } else {
        synth.caveats.push('LLM output did not validate; returned deterministic baseline only.');
      }
    } catch (e) {
      logger?.warn?.('voc', null, 'LLM synthesis failed; deterministic-only result', e?.message);
      synth.caveats.push('LLM synthesis unavailable; review counts + sentiment only.');
    }
  } else if (skipLlm) {
    synth.caveats.push('Free tier with <20 reviews — upgrade or collect more reviews for LLM synthesis.');
  }

  // ─── Build final response ──────────────────────────────────────────────
  return {
    source_count: {
      google: (google || []).length,
      facebook: (facebook || []).length,
      instagram: (instagram || []).length,
      email: (email || []).length,
    },
    total_reviews_analyzed: normalized.length,
    primary_language: marketProfile.primary_language,
    review_languages_detected: [...new Set(normalized.map((r) => r.lang).filter(Boolean))],
    pain_points: synth.pain_points,
    jtbd_signals: synth.jtbd_signals,
    persona_refinement: synth.persona_refinement,
    sentiment: { ...sentimentPcts, trend_30d: trend },
    competitor_mentions: synth.competitor_mentions,
    recommendations_for_marketing: synth.recommendations_for_marketing,
    trigger_events: synth.trigger_events,
    positioning_implications: synth.positioning_implications,
    data_quality: normalized.length >= 50 ? 'good' : normalized.length >= 20 ? 'limited' : 'minimal',
    caveats: synth.caveats,
    short_circuited: false,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function _shortCircuit({ reason, normalized, marketProfile }) {
  return {
    source_count: {},
    total_reviews_analyzed: normalized.length,
    primary_language: marketProfile?.primary_language || 'en',
    review_languages_detected: [],
    pain_points: [],
    jtbd_signals: [],
    persona_refinement: null,
    sentiment: null,
    competitor_mentions: [],
    recommendations_for_marketing: [],
    trigger_events: [],
    positioning_implications: [],
    data_quality: 'insufficient',
    caveats: [reason],
    short_circuited: true,
    short_circuit_reason: reason,
  };
}

function mergeCompetitors(deterministic, fromLlm) {
  const map = new Map();
  for (const m of deterministic || []) map.set(String(m.competitor).toLowerCase(), m);
  for (const m of fromLlm || []) {
    const k = String(m.competitor || '').toLowerCase();
    if (!k) continue;
    if (map.has(k)) {
      // prefer deterministic frequency, add LLM context if absent
      const existing = map.get(k);
      if (!existing.context && m.context) existing.context = m.context;
    } else {
      map.set(k, m);
    }
  }
  return [...map.values()];
}

module.exports = {
  synthesizeVoc,
  validateOutput,
  buildSystemPrompt,
  clusterer: cl,
};
