'use strict';

/**
 * services/voc-scraper/orchestrator.js
 * ---------------------------------------------------------------------------
 * Multi-source VoC orchestrator.
 *
 * Flow:
 *   1. For a given business, fetch reviews from every configured source
 *      (Google Places + Yelp + Trustpilot + manual) in parallel.
 *   2. Concatenate + dedupe review text.
 *   3. Optionally fetch competitor reviews (1-star) if a competitor name
 *      is supplied — gives us the "agitate competitor flaw" signal.
 *   4. Pipe everything through services/voc-scraper/index.js#ingestReviews
 *      which extracts structured VoC phrases and persists to customer_insights.
 *   5. lib/groundingContext.js picks the phrases up automatically on the
 *      next prompt build.
 *
 * Failure modes (all soft):
 *   - One source errors        → others still contribute
 *   - All sources empty        → orchestrator returns { ok: true, inserted: 0 }
 *   - extractor fails          → return { ok: false } so caller can retry
 *
 * Public API:
 *
 *   runForBusiness({ businessId, sources, competitor?, deps })
 *     → {
 *         ok, sources: {google: {...}, yelp: {...}, ...},
 *         totalReviewsFetched, totalReviewsCompetitor, inserted, extracted
 *       }
 *
 * Telemetry (via injected metrics):
 *   - voc_scrape_runs_total{source, status}
 *   - voc_reviews_fetched_total{source}
 *   - voc_phrases_extracted_total{category}
 * ---------------------------------------------------------------------------
 */

const vocScraper = require('./index');

// Source registry — keys map to module paths under ./sources/
const SOURCE_REGISTRY = {
  google_places: () => require('./sources/google-places'),
  yelp: () => require('./sources/yelp'),
  trustpilot: () => require('./sources/trustpilot'),
  manual: () => require('./sources/manual'),
};

/**
 * Fetch from a single source. Catches any exception so a misbehaving
 * adapter doesn't crash the whole run.
 */
async function _fetchSource(sourceName, params, metrics, logger) {
  const factory = SOURCE_REGISTRY[sourceName];
  if (!factory) return { ok: false, source: sourceName, reason: 'unknown source' };
  let adapter;
  try {
    adapter = factory();
  } catch (e) {
    return { ok: false, source: sourceName, reason: 'failed to load: ' + e.message };
  }
  try {
    const r = await adapter.fetch(params || {});
    if (metrics?.increment) {
      metrics.increment('voc_scrape_runs_total', {
        source: sourceName,
        status: r?.ok ? 'ok' : 'fail',
      });
      if (r?.ok && Array.isArray(r.reviews)) {
        metrics.increment('voc_reviews_fetched_total', { source: sourceName }, r.reviews.length);
      }
    }
    return r;
  } catch (e) {
    logger?.warn?.('voc-orchestrator.fetch', null, `${sourceName} threw`, { error: e.message });
    if (metrics?.increment) {
      metrics.increment('voc_scrape_runs_total', { source: sourceName, status: 'error' });
    }
    return { ok: false, source: sourceName, reason: 'throw: ' + e.message };
  }
}

/**
 * Dedupe + join review text blocks. Two reviews are "the same" if the
 * first 80 normalized chars match.
 */
function _dedupeReviews(reviews) {
  const seen = new Set();
  const out = [];
  for (const r of reviews) {
    if (!r?.text) continue;
    const key = r.text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Main entrypoint. Pulls from all configured sources, dedupes, and pipes
 * through the extractor.
 *
 * @param {object} args
 * @param {string} args.businessId
 * @param {object} args.sources    Per-source params. Example:
 *   {
 *     google_places: { placeId: 'ChIJ...', language: 'sq' },
 *     yelp: { businessName: 'Test Cafe', city: 'Tirana' },
 *     trustpilot: { domain: 'testcafe.al' },
 *     manual: { reviewsText: 'pasted...' }
 *   }
 * @param {object} args.competitor (optional) — fetch this competitor's
 *   1-star reviews and feed them to the extractor as competitor_reviews.
 *   Same shape as args.sources but only `manual` + `google_places` make
 *   sense (Yelp doesn't filter by rating).
 * @param {object} args.deps       { callClaude, sbPost, logger?, metrics? }
 */
async function runForBusiness({ businessId, sources = {}, competitor, deps } = {}) {
  if (!businessId) return { ok: false, reason: 'businessId required' };
  if (!deps?.callClaude || !deps?.sbPost) return { ok: false, reason: 'callClaude + sbPost required' };

  const { callClaude, sbPost, logger, metrics } = deps;

  // ─── Step 1: fetch from each source in parallel ────────────────────
  const sourceNames = Object.keys(sources).filter((s) => SOURCE_REGISTRY[s]);
  const sourceTasks = sourceNames.map((name) => _fetchSource(name, sources[name], metrics, logger));
  const sourceResults = await Promise.all(sourceTasks);

  // Collect successful reviews
  const allReviews = [];
  const sourceSummary = {};
  for (let i = 0; i < sourceNames.length; i++) {
    const name = sourceNames[i];
    const r = sourceResults[i];
    sourceSummary[name] = { ok: !!r.ok, count: r.ok ? r.reviews?.length || 0 : 0, reason: r.reason };
    if (r.ok && Array.isArray(r.reviews)) {
      for (const rv of r.reviews) {
        if (rv.text) allReviews.push(rv);
      }
    }
  }

  const deduped = _dedupeReviews(allReviews);

  // ─── Step 2: optionally fetch competitor reviews ────────────────────
  let competitorReviewsText = '';
  if (competitor && typeof competitor === 'object') {
    const compNames = Object.keys(competitor).filter((s) => SOURCE_REGISTRY[s]);
    const compTasks = compNames.map((name) => _fetchSource(name, competitor[name], metrics, logger));
    const compResults = await Promise.all(compTasks);
    const compReviews = [];
    for (const r of compResults) {
      if (r.ok && Array.isArray(r.reviews)) {
        // Filter to 1-2 star reviews when rating data is available
        const lowRated = r.reviews.filter((rv) => rv.rating == null || rv.rating <= 2);
        compReviews.push(...lowRated);
      }
    }
    competitorReviewsText = _dedupeReviews(compReviews)
      .map((r) => `[${r.rating ?? '?'}★] ${r.text}`)
      .join('\n\n');
  }

  if (deduped.length === 0 && !competitorReviewsText) {
    return {
      ok: true,
      reason: 'no reviews from any source',
      sources: sourceSummary,
      totalReviewsFetched: 0,
      totalReviewsCompetitor: 0,
      inserted: 0,
    };
  }

  // ─── Step 3: format + extract + persist via the existing extractor ──
  const reviewsText = deduped.map((r) => `[${r.rating ?? '?'}★ from ${r.source ?? ''}] ${r.text}`).join('\n\n');

  const ingestResult = await vocScraper.ingestReviews({
    callClaude,
    sbPost,
    businessId,
    reviewsText,
    competitorReviewsText: competitorReviewsText || undefined,
    source: 'orchestrator',
    logger,
  });

  if (metrics?.increment && ingestResult?.extracted) {
    const e = ingestResult.extracted;
    for (const cat of ['love_phrases', 'pain_phrases', 'competitor_complaints', 'jtbd_phrases', 'trigger_events']) {
      const count = (e[cat] || []).length;
      if (count > 0) metrics.increment('voc_phrases_extracted_total', { category: cat }, count);
    }
  }

  return {
    ok: ingestResult?.ok !== false,
    sources: sourceSummary,
    totalReviewsFetched: deduped.length,
    totalReviewsCompetitor: competitorReviewsText ? competitorReviewsText.split('\n\n').filter(Boolean).length : 0,
    inserted: ingestResult?.inserted || 0,
    extracted: ingestResult?.extracted || null,
    reason: ingestResult?.reason,
  };
}

module.exports = {
  runForBusiness,
  SOURCE_REGISTRY,
  _dedupeReviews,
  _fetchSource,
};
