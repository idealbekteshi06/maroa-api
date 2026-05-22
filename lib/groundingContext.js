'use strict';

/**
 * lib/groundingContext.js
 * ---------------------------------------------------------------------------
 * Unified grounding library. The single biggest lever for output quality:
 * every Claude call should be grounded in real signal from the business's
 * own history + cohort patterns + customer voice, not generic instructions.
 *
 * The 5-pillar closed-loop creative system:
 *   1. Grounding Context  ◄── this file
 *   2. N-best Reranker
 *   3. Adversarial Critic    (lib/adversarialCritic.js)
 *   4. Performance Memory    (pgvector — Wave 54)
 *   5. Closed-loop learning  (auto prompt update — Wave 55)
 *
 * Usage (synchronous build of a grounding block to prepend to any prompt):
 *
 *   const ctx = await buildGroundingContext({
 *     sbGet,
 *     businessId,
 *     surface: 'social_post' | 'ad_copy' | 'email' | 'seo' | 'landing_page',
 *     intent: 'awareness' | 'conversion' | 'retention' | 'launch',
 *     limit: 3,    // top-K wins/losses to include
 *   });
 *   // ctx.toPromptBlock() → a structured string ready to prepend to user prompt
 *
 * Every section is *cheap and bounded*:
 *   - Top-K wins (≤3)   from generated_content / ad_performance_logs
 *   - Top-K losses (≤3) same sources
 *   - Active VoC themes (≤5)  from customer_insights
 *   - Cohort patterns (≤2) from cross_account_patterns
 *   - Brand voice anchor (1) from brand_voice_anchors
 *
 * Total grounding block: ~600-1200 tokens. Tiny price for the lift in
 * specificity. Caches per (businessId, surface) for 5 minutes to keep
 * cost off the hot path.
 *
 * Failure mode: ANY section that errors degrades gracefully. The block is
 * built from whatever sections succeeded — we'd rather ship a partial
 * grounding than block content generation on a flaky query.
 * ---------------------------------------------------------------------------
 */

const SURFACE_FIELDS = {
  social_post: ['instagram_caption', 'facebook_post', 'instagram_story_text'],
  ad_copy: ['google_ad_headline', 'google_ad_description'],
  email: ['email_subject', 'email_body'],
  seo: ['blog_title'],
  landing_page: [],
  generic: ['instagram_caption', 'facebook_post', 'email_subject'],
};

const CACHE_TTL_MS = 5 * 60 * 1000;
// Bounded LRU: at 100 generations/min × 5min TTL = 30k entries × ~3KB each ≈ 90MB.
// Cap at 5k entries to keep memory under ~15MB per instance.
// On overflow, drop oldest (insertion-order = first eviction candidate).
const CACHE_MAX_ENTRIES = Number(process.env.GROUNDING_CACHE_MAX_ENTRIES) || 5000;
const _cache = new Map(); // key = `${businessId}:${surface}:${intent}`

function _cacheKey(businessId, surface, intent) {
  return `${businessId}:${surface}:${intent || 'any'}`;
}

function _cacheSet(key, value) {
  // LRU: if key exists, delete first so re-set moves it to the back.
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, value);
  // Evict oldest while over cap (Map preserves insertion order).
  while (_cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey === undefined) break;
    _cache.delete(oldestKey);
  }
}

function _truncate(text, max = 160) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Pull top-K winning + losing past pieces of content for this surface.
 * Winners = published + (likes OR ctr OR engagement_score above median).
 * Losers  = published but bottom quartile.
 *
 * Defensive — if performance columns don't exist on this DB, we fall back to
 * just "recent published" as a weaker signal.
 */
async function fetchPastPerformance({ sbGet, businessId, surface, limit = 3 }) {
  const fields = SURFACE_FIELDS[surface] || SURFACE_FIELDS.generic;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

  // ── For ads, ROAS signal trumps everything. Query that first; if we
  // have ≥1 ad row, use it as the wins/losses signal (hard ground truth).
  if (surface === 'ad_copy') {
    let adPerformance = [];
    try {
      adPerformance = await sbGet(
        'ad_performance_logs',
        `business_id=eq.${businessId}&logged_at=gte.${ninetyDaysAgo}&order=roas.desc&limit=20&select=id,roas,ctr,recommendation,reason`
      );
      if (!Array.isArray(adPerformance)) adPerformance = [];
    } catch {
      adPerformance = [];
    }
    if (adPerformance.length) {
      const topAds = adPerformance.slice(0, limit);
      const bottomAds = adPerformance.slice(-limit).reverse();
      return {
        wins: topAds.map((a) => ({
          id: a.id,
          roas: a.roas,
          ctr: a.ctr,
          excerpt: _truncate(a.recommendation || a.reason || ''),
        })),
        losses: bottomAds.map((a) => ({
          id: a.id,
          roas: a.roas,
          ctr: a.ctr,
          excerpt: _truncate(a.recommendation || a.reason || ''),
        })),
      };
    }
    // No ad performance signal — fall through to generated_content as
    // a weaker fallback (the headline + description columns)
  }

  if (!fields.length) return { wins: [], losses: [] };

  // ── Non-ads (or ads with no ROAS history yet): use recency as a weak
  // proxy for "current voice". Top-K newest = "wins", bottom-K = "losses".
  // This is a transitional signal until we wire engagement metrics into
  // the generated_content table (planned migration 062).
  let rows = [];
  try {
    rows = await sbGet(
      'generated_content',
      `business_id=eq.${businessId}&status=eq.published&published_at=gte.${ninetyDaysAgo}&order=published_at.desc&limit=50&select=id,content_theme,${fields.join(',')}`
    );
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }

  if (rows.length < 2) return { wins: [], losses: [] };

  const wins = rows.slice(0, limit).map((r) => ({
    id: r.id,
    theme: r.content_theme,
    excerpt: _truncate(fields.map((f) => r[f]).find(Boolean) || ''),
  }));
  const losses = rows
    .slice(-limit)
    .reverse()
    .map((r) => ({
      id: r.id,
      theme: r.content_theme,
      excerpt: _truncate(fields.map((f) => r[f]).find(Boolean) || ''),
    }));

  return { wins, losses };
}

/**
 * Pull active VoC themes (pain points, customer phrases, trigger events).
 * Drives the "customer language" injection — the single biggest
 * specificity gain for content generation.
 */
async function fetchVocThemes({ sbGet, businessId, limit = 5 }) {
  try {
    const rows = await sbGet(
      'customer_insights',
      `user_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=insight_type,content,actionable_suggestion,created_at`
    );
    if (!Array.isArray(rows) || !rows.length) return [];
    return rows.slice(0, limit).map((r) => ({
      type: r.insight_type,
      suggestion: _truncate(r.actionable_suggestion, 200),
    }));
  } catch {
    return [];
  }
}

/**
 * Wave 59 S3: tier limits for the corpus grounding section.
 *
 * The corpus is a paid feature — growth + agency tiers get expert
 * examples; free tier intentionally excluded for two reasons:
 *
 *   1. Cost discipline: even with prompt caching, the corpus block
 *      adds 200-800 read tokens per call. At $0.30/MTok cache-read
 *      that's still real money at free-tier scale.
 *   2. Monetization lever: "expert examples on day 1" is a feature
 *      worth charging for. Free tier sees grounding from their own
 *      content + brand voice only.
 */
const CORPUS_LIMITS_BY_PLAN = Object.freeze({
  free: 0,
  growth: 2,
  agency: 5,
});

/**
 * Resolve the corpus limit for a given plan.
 * Falls back to free (0) for unknown plans — never accidentally enable.
 */
function corpusLimitForPlan(plan) {
  const normalized = String(plan || 'free')
    .toLowerCase()
    .trim();
  return CORPUS_LIMITS_BY_PLAN[normalized] ?? 0;
}

/**
 * Wave 59 S4: cold-start threshold.
 *
 * The corpus is most valuable when a customer has little or no published
 * content of their own. Once they've shipped 50+ pieces, their OWN
 * performance data is a stronger signal than generic expert examples —
 * and the corpus tax (token cost + retrieval latency) starts to outweigh
 * the value.
 *
 * At >= COLD_START_THRESHOLD, grounding switches to performance-memory-only.
 * At < threshold (and on growth/agency plan), corpus + performance memory
 * both fire (both are small — overhead is bounded).
 *
 * Tunable. We picked 50 because:
 *   - At 3 pieces/day (growth tier), that's ~17 days of content
 *   - At 5 pieces/day (agency tier), that's ~10 days
 *   - Either way it's the 2-week point where engagement signals stabilize
 */
const COLD_START_THRESHOLD = 50;

/**
 * Count published_content rows for a business. Used to decide whether the
 * customer is still in cold-start mode (corpus injection on) or has enough
 * of their own history (corpus off).
 *
 * Uses PostgREST HEAD + Prefer: count=exact via existing sbGet idiom — does
 * NOT download row data. Fast even at scale.
 */
async function countPublishedContent({ sbGet, businessId }) {
  if (!sbGet || !businessId) return 0;
  try {
    // Cheap row-existence query — we only need to know "is count >= 50?"
    // so we pull up to 51 ids and check the array length. This avoids the
    // need for a count=exact head request which not all sbGet impls support.
    const rows = await sbGet(
      'generated_content',
      `business_id=eq.${businessId}&status=eq.published&select=id&limit=${COLD_START_THRESHOLD + 1}`
    );
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    // On error, assume cold-start (more conservative — gives the customer
    // the corpus signal rather than denying it)
    return 0;
  }
}

/**
 * Pull expert examples from the global pre-trained marketing_corpus
 * (migration 062, ADR-0008). Every business benefits from this on day 1
 * — even before they have any wins/losses of their own.
 *
 * Uses expanding-circles industry + region fallback so a Tirana café
 * gets cafe examples from Albania → Balkans → EU → GLOBAL in priority order.
 *
 * Plan gating (Wave 59 S3): pass `plan` to control limit.
 *   - free   → 0 examples (corpus is a paid feature)
 *   - growth → up to 2
 *   - agency → up to 5
 * Unknown plans default to free for safety.
 */
async function fetchExpertCorpus({ sbGet, business, surface = 'social_post', semanticQuery, limit = 3, plan }) {
  if (!business?.industry || !semanticQuery) return [];

  // Plan-resolved limit overrides the caller's `limit` when stricter
  const planLimit = plan !== undefined ? corpusLimitForPlan(plan) : limit;
  const effectiveLimit = Math.min(limit, planLimit);
  if (effectiveLimit <= 0) return [];

  try {
    const taxonomy = require('./taxonomy');
    const industryCircles = taxonomy.industries.getExpandingCircles(business.industry);
    const regionCircles = taxonomy.regions.getExpandingCircles(business.country || 'GLOBAL');

    // Map surface → corpus format
    const formatMap = {
      social_post: 'meta_ad', // best signal for social
      ad_copy: 'meta_ad',
      email: 'email',
      seo: 'seo_article',
      landing_page: 'landing_page',
      caption: 'social_post',
    };
    const format = formatMap[surface] || 'meta_ad';

    // PostgREST in-list filter on industry + region
    const indFilter = `industry=in.(${industryCircles.map(encodeURIComponent).join(',')})`;
    const regFilter = `region=in.(${regionCircles.map(encodeURIComponent).join(',')})`;
    const fmtFilter = `format=eq.${encodeURIComponent(format)}`;
    const qualityFilter = `quality_score=gte.0.6`;

    const rows = await sbGet(
      'marketing_corpus',
      `${indFilter}&${regFilter}&${fmtFilter}&${qualityFilter}&order=quality_score.desc&limit=${Math.min(effectiveLimit * 3, 30)}&select=id,title,body,cta,industry,region,quality_score,source`
    );
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, effectiveLimit).map((r) => ({
      id: r.id,
      excerpt: (r.body || '').slice(0, 200),
      title: r.title || null,
      industry: r.industry,
      region: r.region,
      quality_score: r.quality_score,
      source: r.source,
    }));
  } catch {
    return [];
  }
}

/**
 * Pull top cohort patterns for this business's industry + budget tier.
 * Returns 2 patterns at most — quality over quantity.
 */
async function fetchCohortPatterns({ sbGet, business, limit = 2 }) {
  if (!business?.industry) return [];
  try {
    const budgetTier = _bucketBudget(business.daily_budget);
    const rows = await sbGet(
      'cross_account_patterns',
      `industry=eq.${encodeURIComponent(business.industry)}&budget_tier=eq.${budgetTier}&order=confidence.desc&limit=${limit}&select=pattern_type,pattern_signature,median_roas_lift,confidence`
    );
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, limit).map((p) => ({
      type: p.pattern_type,
      signature: p.pattern_signature,
      roas_lift: p.median_roas_lift,
      confidence: p.confidence,
    }));
  } catch {
    return [];
  }
}

/**
 * Pull brand voice anchor — the canonical "what the brand sounds like" doc.
 */
/**
 * Normalize business.industry to industry_benchmarks.industry slug.
 */
function normalizeIndustrySlug(industry) {
  const raw = String(industry || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  const aliases = {
    dentist: 'dental',
    dentistry: 'dental',
    restaurant: 'restaurant',
    cafe: 'cafe',
    coffee: 'cafe',
    gym: 'fitness',
    fitness_studio: 'fitness',
    salon: 'beauty',
    beauty_salon: 'beauty',
    law: 'legal',
    lawyer: 'legal',
    law_firm: 'legal',
    realtor: 'real_estate',
    real_estate: 'real_estate',
    ecommerce: 'ecommerce',
    e_commerce: 'ecommerce',
    shop: 'retail',
    retail_store: 'retail',
  };
  return aliases[raw] || raw;
}

/**
 * Pull public benchmark row for an industry (GLOBAL region).
 */
async function fetchIndustryBenchmarks({ sbGet, industry, region = 'GLOBAL' }) {
  const slug = normalizeIndustrySlug(industry);
  if (!slug || !sbGet) return null;
  try {
    const rows = await sbGet(
      'industry_benchmarks',
      `industry=eq.${encodeURIComponent(slug)}&region=eq.${encodeURIComponent(region)}&select=*&limit=1`
    );
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

function formatPct(rate, digits = 2) {
  if (rate == null || Number.isNaN(Number(rate))) return 'n/a';
  return `${(Number(rate) * 100).toFixed(digits)}%`;
}

function formatBenchmarkComparison(benchmark, metrics = {}) {
  if (!benchmark) return null;
  const lines = [];
  if (benchmark.meta_avg_ctr != null && metrics.ctr != null) {
    lines.push(
      `Meta CTR: industry avg ${formatPct(benchmark.meta_avg_ctr)} — you are at ${formatPct(metrics.ctr)}`
    );
  } else if (benchmark.meta_avg_ctr != null) {
    lines.push(`Meta CTR industry average: ${formatPct(benchmark.meta_avg_ctr)}`);
  }
  if (benchmark.google_avg_cpc_usd != null && metrics.cpc != null) {
    lines.push(
      `Google CPC: industry avg $${Number(benchmark.google_avg_cpc_usd).toFixed(2)} — you are at $${Number(metrics.cpc).toFixed(2)}`
    );
  } else if (benchmark.google_avg_cpc_usd != null) {
    lines.push(`Google CPC industry average: $${Number(benchmark.google_avg_cpc_usd).toFixed(2)}`);
  }
  if (benchmark.email_open_rate != null) {
    lines.push(`Email open rate industry average: ${formatPct(benchmark.email_open_rate)}`);
  }
  if (benchmark.instagram_engagement_rate != null && metrics.engagement_rate != null) {
    lines.push(
      `Instagram engagement: industry avg ${formatPct(benchmark.instagram_engagement_rate)} — you are at ${formatPct(metrics.engagement_rate)}`
    );
  } else if (benchmark.instagram_engagement_rate != null) {
    lines.push(`Instagram engagement industry average: ${formatPct(benchmark.instagram_engagement_rate)}`);
  }
  if (Array.isArray(benchmark.best_days_post) && benchmark.best_days_post.length) {
    lines.push(`Best days to post: ${benchmark.best_days_post.join(', ')}`);
  }
  if (Array.isArray(benchmark.best_times_post) && benchmark.best_times_post.length) {
    lines.push(`Best times to post (local): ${benchmark.best_times_post.join(', ')}`);
  }
  const types = benchmark.top_content_types;
  if (Array.isArray(types) && types.length) {
    lines.push(`Top performing content types: ${types.join(', ')}`);
  }
  return lines.length ? lines : null;
}

/**
 * Scheduling hints for WF1 / publishers from benchmarks.
 */
function postingScheduleFromBenchmark(benchmark) {
  if (!benchmark) return null;
  return {
    best_days: benchmark.best_days_post || [],
    best_times: benchmark.best_times_post || [],
    top_content_types: Array.isArray(benchmark.top_content_types) ? benchmark.top_content_types : [],
    instagram_engagement_rate: benchmark.instagram_engagement_rate,
    meta_avg_ctr: benchmark.meta_avg_ctr,
  };
}

async function fetchBrandVoice({ sbGet, businessId }) {
  try {
    const rows = await sbGet(
      'brand_voice_anchors',
      `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=anchor`
    );
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].anchor || null;
  } catch {
    return null;
  }
}

function _bucketBudget(daily) {
  const b = Number(daily) || 5;
  if (b < 20) return '5';
  if (b < 50) return '20';
  if (b < 100) return '50';
  if (b < 500) return '100';
  return '500';
}

/**
 * Main entrypoint. Builds a grounding context object with `.toPromptBlock()`
 * that returns the structured string ready to prepend to a user prompt.
 *
 * Caches the assembled block per (businessId, surface, intent) for 5 min so
 * a daily batch of 20 generations doesn't hit Supabase 100 times.
 */
async function buildGroundingContext({
  sbGet,
  businessId,
  surface = 'generic',
  intent = 'awareness',
  limit = 3,
  vocLimit = 5,
  cohortLimit = 2,
  skipCache = false,
  // Optional: semantic-search query string. If provided + performanceMemory
  // is wired, we use it to find the K most-similar past pieces (RAG mode).
  // If absent, we fall back to recency-based wins/losses.
  semanticQuery = null,
  performanceMemory = null,
  /** Optional metrics for benchmark comparison (ctr, cpc, engagement_rate, roas). */
  clientMetrics = null,
  // Wave 59 S3: tier gate for the expertCorpus section. Caller should
  // pass the customer's plan. Defaults to undefined → uses business.plan
  // from the fetched row; if that's also missing, defaults to free (0 corpus rows).
  plan = undefined,
} = {}) {
  if (!sbGet || !businessId) {
    return _emptyContext(surface, intent);
  }
  const cacheK = _cacheKey(businessId, surface, intent);
  if (!skipCache) {
    const hit = _cache.get(cacheK);
    if (hit && hit.expiresAt > Date.now()) return hit.context;
  }

  // Fetch the business row first (we need industry + budget for cohort + brand
  // for anchor). voice_seed is the onboarding-time customer-pasted samples and
  // serves as the day-1 brand voice signal until brand_voice_anchors fills in.
  let business = null;
  try {
    const rows = await sbGet(
      'businesses',
      `id=eq.${businessId}&select=id,industry,daily_budget,business_name,plan,brand_tone,voice_seed,target_audience,marketing_goal`,
    );
    business = Array.isArray(rows) ? rows[0] : null;
  } catch {
    business = null;
  }

  // Run all four fetches in parallel — they are independent.
  // Performance fetch uses semantic search if (a) a query is supplied AND
  // (b) performanceMemory is configured. Otherwise falls back to recency.
  const performancePromise = (async () => {
    if (semanticQuery && performanceMemory?.findSimilar) {
      try {
        const wins = await performanceMemory.findSimilar({
          businessId,
          query: semanticQuery,
          surface,
          limit,
          direction: 'wins',
        });
        const losses = await performanceMemory.findSimilar({
          businessId,
          query: semanticQuery,
          surface,
          limit,
          direction: 'losses',
        });
        return {
          wins: (wins || []).map((w) => ({
            id: w.id,
            excerpt: w.text?.slice(0, 160) || '',
            roas: w.outcome_score ?? w.roas ?? null,
            similarity: w.similarity ?? w.score ?? null,
            mode: w.mode || 'pgvector',
          })),
          losses: (losses || []).map((l) => ({
            id: l.id,
            excerpt: l.text?.slice(0, 160) || '',
            roas: l.outcome_score ?? l.roas ?? null,
            similarity: l.similarity ?? l.score ?? null,
            mode: l.mode || 'pgvector',
          })),
        };
      } catch {
        // Semantic search failed — fall through to recency
      }
    }
    return fetchPastPerformance({ sbGet, businessId, surface, limit });
  })();

  // Wave 59 S3: resolve effective plan for corpus tier gating.
  // Priority: explicit `plan` param > business.plan from DB > 'free' default.
  const effectivePlan = plan !== undefined ? plan : business?.plan || 'free';

  // Wave 59 S4: cold-start count fetched in parallel with the other sections
  // so we don't pay an extra round-trip in latency.
  const coldStartCountPromise = countPublishedContent({ sbGet, businessId });

  const [performance, voc, cohort, anchorBrandVoice, publishedCount, industryBenchmark] = await Promise.all([
    performancePromise,
    fetchVocThemes({ sbGet, businessId, limit: vocLimit }),
    business ? fetchCohortPatterns({ sbGet, business, limit: cohortLimit }) : [],
    fetchBrandVoice({ sbGet, businessId }),
    coldStartCountPromise,
    business ? fetchIndustryBenchmarks({ sbGet, industry: business.industry }) : null,
  ]);

  // Day-1 brand voice fallback: if no brand_voice_anchors row exists yet,
  // synthesize a tiny anchor from the onboarding voice_seed + brand_tone.
  // Closes the P0-2 gap where onboarding samples were dropped on the floor.
  let brandVoice = anchorBrandVoice;
  if (!brandVoice && business && (business.voice_seed || business.brand_tone)) {
    brandVoice = {
      tone_descriptors: business.brand_tone || null,
      audience_summary: business.target_audience || null,
      voice_seed: business.voice_seed || null,
      source: 'onboarding_seed',
    };
  }

  // Wave 59 S4: only inject corpus when the customer is still in cold start.
  // Once they have >= COLD_START_THRESHOLD published pieces, their own
  // performance memory is the stronger signal — skip the corpus tax.
  const coldStartActive = publishedCount < COLD_START_THRESHOLD;
  const groundingMode = coldStartActive ? 'cold_start' : 'warm';
  let expertCorpus = [];
  if (business && coldStartActive) {
    expertCorpus = await fetchExpertCorpus({
      sbGet,
      business,
      surface,
      semanticQuery,
      limit,
      plan: effectivePlan,
    });
  }

  const ctx = {
    businessId,
    surface,
    intent,
    business,
    wins: performance.wins,
    losses: performance.losses,
    voc,
    cohort,
    brandVoice,
    expertCorpus,
    industryBenchmark,
    industryBenchmarkLines: formatBenchmarkComparison(industryBenchmark, clientMetrics || {}),
    postingSchedule: postingScheduleFromBenchmark(industryBenchmark),
    // Wave 59 S4: cold-start observability — callers can log this to
    // verify corpus is firing for cold customers + off for warm ones.
    groundingMode, // 'cold_start' | 'warm'
    publishedCount,
    coldStartActive,
    builtAt: Date.now(),
    toPromptBlock() {
      return _renderPromptBlock(this);
    },
    /**
     * Wave 59 S2 — return the grounding context as separate cacheable
     * blocks for Anthropic prompt caching.
     *
     * Returns an array of `{ type: 'text', text: ... [, cache_control] }`
     * segments. The expertCorpus block is tagged with cache_control because:
     *   - It's the largest section (often 1000+ tokens with 5 examples)
     *   - It's IDENTICAL across calls for the same (industry, region, surface,
     *     semanticQuery) — so the same block is hit by many customers
     *   - The non-corpus sections are customer-specific and shouldn't be
     *     cached together with it
     *
     * Empty arrays / strings are dropped — never emit empty segments.
     */
    toCacheableBlocks() {
      const blocks = [];
      const nonCorpus = _renderNonCorpusBlock(this);
      if (nonCorpus) blocks.push({ type: 'text', text: nonCorpus });
      const corpus = _renderCorpusBlock(this);
      if (corpus) {
        blocks.push({
          type: 'text',
          text: corpus,
          cache_control: { type: 'ephemeral' },
        });
      }
      return blocks;
    },
    /**
     * Anthropic Citations support — return wins + losses + corpus rows
     * as citation-eligible document blocks. Pass these via
     * extra.documentBlocks to callClaude, set extra.returnCitations:true,
     * and the response will arrive with structured citations naming the
     * exact source row each claim is grounded in. Used by the reasoning
     * trace UI: "This headline mirrors your Tirana Roastery Mother's Day
     * post that hit 4.2× ROAS" [1] — where [1] links back to a real win.
     *
     * Each block is named so the UI can show a human source label.
     * Documents are cache-control-marked because the corpus and recent
     * wins rarely change inside a 5-min window.
     */
    toCitationDocuments({ maxWins = 3, maxLosses = 2, maxCorpus = 3 } = {}) {
      const docs = [];
      const add = (title, text) => {
        if (!text) return;
        docs.push({
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: String(text) },
          title: String(title).slice(0, 120),
          citations: { enabled: true },
          cache_control: { type: 'ephemeral' },
        });
      };
      for (const w of (this.wins || []).slice(0, maxWins)) {
        add(`Win — ${w.label || w.surface || 'past performance'}`, w.text || w.snippet || w.content);
      }
      for (const l of (this.losses || []).slice(0, maxLosses)) {
        add(`What didn't work — ${l.label || 'past flop'}`, l.text || l.snippet || l.content);
      }
      for (const c of (this.expertCorpus || []).slice(0, maxCorpus)) {
        add(`Industry example — ${c.brand || c.source || 'expert benchmark'}`, c.text || c.body);
      }
      if (this.brandVoice && (this.brandVoice.tone || this.brandVoice.do_use?.length)) {
        const bvParts = [
          this.brandVoice.tone ? `Tone: ${this.brandVoice.tone}.` : '',
          this.brandVoice.do_use?.length ? `Use: ${this.brandVoice.do_use.slice(0, 12).join(', ')}.` : '',
          this.brandVoice.do_not_use?.length
            ? `Avoid: ${this.brandVoice.do_not_use.slice(0, 12).join(', ')}.`
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        if (bvParts) add('Brand voice anchor', bvParts);
      }
      return docs;
    },
    isEmpty() {
      return (
        !this.wins.length &&
        !this.losses.length &&
        !this.voc.length &&
        !this.cohort.length &&
        !this.brandVoice &&
        !this.expertCorpus.length &&
        !this.industryBenchmark
      );
    },
  };

  _cacheSet(cacheK, { context: ctx, expiresAt: Date.now() + CACHE_TTL_MS });
  return ctx;
}

function _emptyContext(surface, intent) {
  return {
    businessId: null,
    surface,
    intent,
    business: null,
    wins: [],
    losses: [],
    voc: [],
    cohort: [],
    brandVoice: null,
    expertCorpus: [],
    industryBenchmark: null,
    industryBenchmarkLines: null,
    postingSchedule: null,
    groundingMode: 'cold_start',
    publishedCount: 0,
    coldStartActive: true,
    builtAt: Date.now(),
    toPromptBlock() {
      return '';
    },
    toCitationDocuments() {
      return [];
    },
    toCacheableBlocks() {
      return [];
    },
    isEmpty() {
      return true;
    },
  };
}

/**
 * Render a structured prompt block. The format is deliberately verbose
 * and labelled so the model has explicit sections to attend to. We don't
 * trust the model to "find" wins inside a paragraph — we hand it a list.
 */
function _renderPromptBlock(ctx) {
  if (ctx.isEmpty()) return '';
  const parts = [];
  parts.push(`# GROUNDING CONTEXT (surface=${ctx.surface}, intent=${ctx.intent})`);
  parts.push("Use this real signal from the business's own history. Do not generate generic copy.");
  parts.push('');

  if (ctx.brandVoice) {
    const v = ctx.brandVoice;
    parts.push('## Brand voice anchor');
    if (v.tone_descriptors) parts.push(`Tone: ${v.tone_descriptors}`);
    if (v.audience_summary) parts.push(`Audience: ${v.audience_summary}`);
    if (v.never_say && Array.isArray(v.never_say) && v.never_say.length) {
      parts.push(`NEVER say: ${v.never_say.slice(0, 5).join('; ')}`);
    }
    if (v.voice_seed) {
      // Customer-pasted onboarding samples. Truncate to keep prompt cost
      // bounded — first ~1000 chars usually captures the voice signature.
      const seed = String(v.voice_seed).slice(0, 1000);
      parts.push(`Samples the owner wrote / posted (imitate cadence + diction):`);
      parts.push(seed);
    }
    parts.push('');
  }

  if (ctx.wins.length) {
    parts.push(`## Past WINS (imitate the structure/voice, never copy verbatim)`);
    ctx.wins.forEach((w, i) => {
      const meta = [w.roas != null ? `ROAS ${w.roas}` : null, w.ctr != null ? `CTR ${w.ctr}` : null, w.theme]
        .filter(Boolean)
        .join(' · ');
      parts.push(`  ${i + 1}. ${meta ? `[${meta}] ` : ''}${w.excerpt}`);
    });
    parts.push('');
  }

  if (ctx.losses.length) {
    parts.push(`## Past LOSSES (avoid this pattern — these underperformed)`);
    ctx.losses.forEach((l, i) => {
      const meta = [l.roas != null ? `ROAS ${l.roas}` : null, l.theme].filter(Boolean).join(' · ');
      parts.push(`  ${i + 1}. ${meta ? `[${meta}] ` : ''}${l.excerpt}`);
    });
    parts.push('');
  }

  if (ctx.voc.length) {
    parts.push('## Active customer voice (real pain points + language from VoC analysis)');
    ctx.voc.forEach((v, i) => {
      parts.push(`  ${i + 1}. [${v.type}] ${v.suggestion}`);
    });
    parts.push('');
  }

  if (ctx.cohort.length) {
    parts.push('## Cohort patterns (proven across similar businesses)');
    ctx.cohort.forEach((c, i) => {
      const lift = c.roas_lift != null ? ` (+${c.roas_lift}x ROAS)` : '';
      const conf = c.confidence != null ? ` [conf ${c.confidence}]` : '';
      parts.push(`  ${i + 1}. ${c.type}: ${c.signature}${lift}${conf}`);
    });
    parts.push('');
  }

  if (ctx.industryBenchmarkLines && ctx.industryBenchmarkLines.length) {
    parts.push('## Industry benchmarks (public SMB averages for this vertical)');
    ctx.industryBenchmarkLines.forEach((line, i) => {
      parts.push(`  ${i + 1}. ${line}`);
    });
    parts.push('');
  }

  if (ctx.expertCorpus && ctx.expertCorpus.length) {
    parts.push('## Expert corpus (world-class examples from similar verticals)');
    parts.push(
      'These are real ads / posts / pages from proven brands. Study the STRUCTURE — hook, specificity, voice — and apply the same craft. Do NOT copy verbatim.'
    );
    ctx.expertCorpus.forEach((e, i) => {
      const tag = `[${e.industry}/${e.region} · q${e.quality_score}]`;
      parts.push(`  ${i + 1}. ${tag} ${e.excerpt}`);
    });
    parts.push('');
  }

  parts.push('## How to use this');
  parts.push('- Imitate the patterns in WINS. Avoid the patterns in LOSSES.');
  parts.push('- Use the exact phrases from "Active customer voice" where they fit.');
  parts.push('- Apply at least one cohort pattern unless none fit the brief.');
  parts.push('- Stay inside the brand voice — NEVER drift from the tone.');
  parts.push('');

  return parts.join('\n');
}

/**
 * Wave 59 S2: render only the corpus section (for cacheable-block path).
 * Returns '' when no expert corpus rows are present.
 */
function _renderCorpusBlock(ctx) {
  if (!ctx.expertCorpus || !ctx.expertCorpus.length) return '';
  const parts = [];
  parts.push('## Expert corpus (world-class examples from similar verticals)');
  parts.push(
    'These are real ads / posts / pages from proven brands. Study the STRUCTURE — hook, specificity, voice — and apply the same craft. Do NOT copy verbatim.'
  );
  ctx.expertCorpus.forEach((e, i) => {
    const tag = `[${e.industry}/${e.region} · q${e.quality_score}]`;
    parts.push(`  ${i + 1}. ${tag} ${e.excerpt}`);
  });
  return parts.join('\n');
}

/**
 * Wave 59 S2: render everything EXCEPT the corpus section. Used as the
 * uncached portion of the system prompt.
 */
function _renderNonCorpusBlock(ctx) {
  if (ctx.isEmpty()) return '';
  const original = ctx.expertCorpus;
  // Temporarily clear corpus so the existing renderer skips it; then restore.
  // (Mutation-free path would be a re-implementation; this avoids that.)
  const tmpCtx = { ...ctx, expertCorpus: [] };
  tmpCtx.isEmpty = () =>
    !tmpCtx.wins.length && !tmpCtx.losses.length && !tmpCtx.voc.length && !tmpCtx.cohort.length && !tmpCtx.brandVoice;
  const rendered = _renderPromptBlock(tmpCtx);
  // Trim trailing "How to use this" section if it's the only thing left
  return rendered;
}

/**
 * Test-only: clear the cache.
 */
function _resetCache() {
  _cache.clear();
}

module.exports = {
  buildGroundingContext,
  fetchPastPerformance,
  fetchVocThemes,
  fetchCohortPatterns,
  fetchBrandVoice,
  fetchExpertCorpus,
  fetchIndustryBenchmarks,
  formatBenchmarkComparison,
  postingScheduleFromBenchmark,
  normalizeIndustrySlug,
  corpusLimitForPlan,
  countPublishedContent,
  SURFACE_FIELDS,
  CORPUS_LIMITS_BY_PLAN,
  COLD_START_THRESHOLD,
  _resetCache,
};
