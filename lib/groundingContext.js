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
const _cache = new Map(); // key = `${businessId}:${surface}:${intent}`

function _cacheKey(businessId, surface, intent) {
  return `${businessId}:${surface}:${intent || 'any'}`;
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
 * Pull expert examples from the global pre-trained marketing_corpus
 * (migration 062, ADR-0008). Every business benefits from this on day 1
 * — even before they have any wins/losses of their own.
 *
 * Uses expanding-circles industry + region fallback so a Tirana café
 * gets cafe examples from Albania → Balkans → EU → GLOBAL in priority order.
 */
async function fetchExpertCorpus({ sbGet, business, surface = 'social_post', semanticQuery, limit = 3 }) {
  if (!business?.industry || !semanticQuery) return [];
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
      `${indFilter}&${regFilter}&${fmtFilter}&${qualityFilter}&order=quality_score.desc&limit=${Math.min(limit * 3, 30)}&select=id,title,body,cta,industry,region,quality_score,source`
    );
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, limit).map((r) => ({
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
} = {}) {
  if (!sbGet || !businessId) {
    return _emptyContext(surface, intent);
  }
  const cacheK = _cacheKey(businessId, surface, intent);
  if (!skipCache) {
    const hit = _cache.get(cacheK);
    if (hit && hit.expiresAt > Date.now()) return hit.context;
  }

  // Fetch the business row first (we need industry + budget for cohort + brand for anchor)
  let business = null;
  try {
    const rows = await sbGet('businesses', `id=eq.${businessId}&select=id,industry,daily_budget,business_name,plan`);
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

  const [performance, voc, cohort, brandVoice, expertCorpus] = await Promise.all([
    performancePromise,
    fetchVocThemes({ sbGet, businessId, limit: vocLimit }),
    business ? fetchCohortPatterns({ sbGet, business, limit: cohortLimit }) : [],
    fetchBrandVoice({ sbGet, businessId }),
    business ? fetchExpertCorpus({ sbGet, business, surface, semanticQuery, limit: limit }) : [],
  ]);

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
    isEmpty() {
      return (
        !this.wins.length &&
        !this.losses.length &&
        !this.voc.length &&
        !this.cohort.length &&
        !this.brandVoice &&
        !this.expertCorpus.length
      );
    },
  };

  _cache.set(cacheK, { context: ctx, expiresAt: Date.now() + CACHE_TTL_MS });
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
    builtAt: Date.now(),
    toPromptBlock() {
      return '';
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
  SURFACE_FIELDS,
  _resetCache,
};
