'use strict';

/**
 * services/public-pretrainer/orchestrator.js
 * ---------------------------------------------------------------------------
 * Main coordinator for the global marketing corpus pre-trainer.
 *
 * Flow per (industry, region) cohort:
 *
 *   1. Fetch from configured sources (Meta Ad Library, Google Places cohort, ...)
 *   2. Dedupe against marketing_corpus by (source, source_ref) — idempotent
 *   3. Classify each new row with Haiku → industry + format + language
 *   4. Quality-score heuristically (runtime + brand authority + content)
 *   5. Embed via lib/embeddingProviders/ (OpenAI ada-3 or stub)
 *   6. INSERT into marketing_corpus
 *   7. Write a row to pretrainer_runs with stats + cost
 *
 * Cost discipline:
 *   - Per-run cap: 500 examples per (industry, region, source) — caller can
 *     override but the default protects against blowups.
 *   - Aggregate cost tracker: sums Haiku + embedding cost per run, surfaces
 *     it in the pretrainer_runs row.
 *   - Idempotency: `source + source_ref` unique constraint in migration 062
 *     means re-runs are free — they hit the dedup check and skip.
 *
 * Failure modes (all soft, no run kills another):
 *   - Source unavailable → skipped, others continue
 *   - Classifier returns 0-confidence → row STILL persisted (quality_score
 *     will be low; retrieval filter hides it). Better to keep it.
 *   - Embedding fails → row persisted WITHOUT embedding; can be backfilled
 *     by a refresh job
 *   - DB write fails on one row → others continue, error_message recorded
 *
 * Public API:
 *
 *   runForCohort({ industryId, regionId, deps, options? })
 *   runForAll({ deps, options? })  — sweeps the full taxonomy
 *
 * Both return { ok, run_id, examples_fetched, examples_kept, cost_usd_cents }.
 * ---------------------------------------------------------------------------
 */

const { industries, regions, expertSources } = require('../../lib/taxonomy');
const classifier = require('./classifier');
const qualityScorer = require('./quality-scorer');

const META_AD_LIBRARY = require('./sources/meta-ad-library');
const GOOGLE_PLACES_COHORT = require('./sources/google-places-cohort');

const DEFAULT_PER_COHORT_LIMIT = 100;
const HAIKU_COST_PER_CLASSIFICATION_CENTS = 0.01; // ~$0.0001 = 0.01¢
const EMBEDDING_COST_PER_CALL_CENTS = 0.005; // ~$0.00005 with ada-3 at 384 dim

// ─── Wave 59 S1: pre-classifier eligibility gate ──────────────────────
// Drops ads that don't meet the (brand-recognition AND runtime) bar BEFORE
// the classifier runs, saving Haiku cost on rows we'd reject anyway.
//
// An ad is eligible iff:
//   - its page_name matches an expert brand (per expert_sources.js), OR is
//     an award winner (the stricter signal — still passes the brand check)
//   - AND it has been running ≥ MIN_RUNTIME_FOR_INGEST days
function _isAdEligible({ ad, expertBrandNames }) {
  if (!ad) return false;

  // Runtime gate — long-running ads have survived split-testing
  const runtimeDays = typeof ad.runtime_days === 'number' ? ad.runtime_days : 0;
  if (runtimeDays < MIN_RUNTIME_FOR_INGEST) return false;

  // Brand recognition gate — must be from a known expert brand
  // (expert brand or award winner). Without this, the keyword-search
  // pass would dump random small advertisers into the corpus.
  const pageName = String(ad.page_name || '')
    .toLowerCase()
    .trim();
  if (!pageName) return false;

  // Award winners pass automatically (already proven craft)
  if (expertSources.isAwardWinner(ad.page_name)) return true;

  // Expert brand list — fuzzy match (matches whole or partial brand name)
  for (const expertName of expertBrandNames) {
    const norm = String(expertName || '')
      .toLowerCase()
      .trim();
    if (!norm) continue;
    if (pageName === norm || pageName.includes(norm) || norm.includes(pageName)) return true;
  }
  return false;
}

const MIN_RUNTIME_FOR_INGEST = 60;

function _aggregateRegionToCountries(regionId) {
  if (regionId === 'GLOBAL') return ['US', 'GB', 'AU', 'CA', 'DE', 'FR', 'JP'];
  if (regionId === 'EU') return ['DE', 'FR', 'GB', 'IT', 'ES', 'NL'];
  if (regionId === 'NA') return ['US', 'CA'];
  if (regionId === 'APAC') return ['JP', 'AU', 'SG', 'IN'];
  if (regionId === 'LATAM') return ['BR', 'MX', 'AR'];
  if (regionId === 'MENA') return ['AE', 'SA', 'IL'];
  return [regionId];
}

/**
 * Start a pretrainer_runs row. Returns its id so we can update it on
 * finish.
 */
async function _beginRun({ sbPost, source, industryId, regionId }) {
  try {
    const r = await sbPost('pretrainer_runs', {
      source,
      industry: industryId,
      region: regionId,
      started_at: new Date().toISOString(),
      status: 'running',
    });
    return r?.[0]?.id || r?.id || null;
  } catch {
    return null;
  }
}

async function _endRun({ sbPatch, runId, stats }) {
  if (!runId || !sbPatch) return;
  try {
    await sbPatch('pretrainer_runs', `id=eq.${runId}`, {
      ...stats,
      finished_at: new Date().toISOString(),
    });
  } catch {
    /* soft-fail */
  }
}

/**
 * Insert one corpus row. Returns true on success.
 */
async function _insertRow({ sbPost, row, logger }) {
  try {
    await sbPost('marketing_corpus', row);
    return true;
  } catch (e) {
    logger?.warn?.('pretrainer.insert', null, 'corpus insert failed', { error: e.message, source: row.source });
    return false;
  }
}

/**
 * Check if a (source, source_ref) is already in marketing_corpus.
 * Single-row lookup, very cheap.
 */
async function _alreadyExists({ sbGet, source, sourceRef }) {
  try {
    const r = await sbGet(
      'marketing_corpus',
      `source=eq.${encodeURIComponent(source)}&source_ref=eq.${encodeURIComponent(sourceRef)}&select=id&limit=1`
    );
    return Array.isArray(r) && r.length > 0;
  } catch {
    return false;
  }
}

/**
 * Run pre-training for a single (industry, region) cohort. Pulls from all
 * configured sources, classifies, scores, embeds, persists.
 */
async function runForCohort({ industryId, regionId, deps, options = {} } = {}) {
  if (!industryId || !regionId) {
    return { ok: false, reason: 'industryId + regionId required' };
  }
  if (!deps?.callClaude || !deps?.sbGet || !deps?.sbPost) {
    return { ok: false, reason: 'callClaude + sbGet + sbPost required' };
  }

  const { callClaude, sbGet, sbPost, sbPatch, logger, metrics } = deps;
  const limit = options.limitPerSource || DEFAULT_PER_COHORT_LIMIT;
  const industry = industries.getById(industryId);
  const region = regions.getById(regionId);
  if (!industry || !region) {
    return { ok: false, reason: `unknown industry/region: ${industryId}/${regionId}` };
  }

  // Start run record (sums across all sources for this cohort)
  const runId = await _beginRun({ sbPost, source: 'orchestrator', industryId, regionId });
  const stats = {
    examples_fetched: 0,
    examples_kept: 0,
    examples_skipped: 0,
    cost_usd_cents: 0,
  };

  // ─── Source 1: Meta Ad Library — expert brands first, then keyword
  const metaCountries = _aggregateRegionToCountries(regionId);
  const expertBrands = expertSources.getBrandsForIndustry(industryId);
  // Names used by _isAdEligible — combine industry-specific expert brands
  // + all award winners (cross-industry — Liquid Death is award-tier even
  // when scraping for some other vertical).
  const expertBrandNames = [...expertBrands.map((b) => b.name), ...expertSources.AWARD_WINNERS.map((w) => w.name)];

  for (const brand of expertBrands.slice(0, options.maxExpertBrands || 6)) {
    for (const country of metaCountries.slice(0, 2)) {
      const r = await META_AD_LIBRARY.fetchByPage({
        pageName: brand.name,
        region: country,
        limit: Math.min(limit / 4, 25),
      });
      if (!r.ok) continue;
      stats.examples_fetched += r.ads.length;
      for (const ad of r.ads) {
        // Wave 59 S1: eligibility gate — drops ads not meeting brand + runtime bar
        if (!_isAdEligible({ ad, expertBrandNames })) {
          stats.examples_skipped++;
          continue;
        }
        const existed = await _alreadyExists({ sbGet, source: 'meta_ad_library', sourceRef: ad.source_ref });
        if (existed) {
          stats.examples_skipped++;
          continue;
        }
        const processed = await _processAndPersist({
          rawRow: { ...ad, source: 'meta_ad_library' },
          industryHint: industryId,
          regionHint: country,
          formatHint: 'meta_ad',
          deps,
          stats,
        });
        if (processed) stats.examples_kept++;
      }
    }
  }

  // Long-tail keyword pass (only if expert-brand pass yielded < 10).
  // Wave 59 S1: the eligibility gate is what makes this safe — without it,
  // keyword search would pull random small advertisers. With it, only
  // expert brands + award winners that happen to mention the keyword pass.
  if (stats.examples_kept < 10 && industry.seedKeywords?.length) {
    for (const kw of industry.seedKeywords.slice(0, 2)) {
      for (const country of metaCountries.slice(0, 1)) {
        const r = await META_AD_LIBRARY.fetchByKeyword({
          keyword: kw,
          region: country,
          limit: Math.min(limit / 2, 50),
        });
        if (!r.ok) continue;
        stats.examples_fetched += r.ads.length;
        for (const ad of r.ads) {
          if (!_isAdEligible({ ad, expertBrandNames })) {
            stats.examples_skipped++;
            continue;
          }
          const existed = await _alreadyExists({ sbGet, source: 'meta_ad_library', sourceRef: ad.source_ref });
          if (existed) {
            stats.examples_skipped++;
            continue;
          }
          const processed = await _processAndPersist({
            rawRow: { ...ad, source: 'meta_ad_library' },
            industryHint: industryId,
            regionHint: country,
            formatHint: 'meta_ad',
            deps,
            stats,
          });
          if (processed) stats.examples_kept++;
        }
      }
    }
  }

  // ─── Source 2: Google Places cohort reviews (only when industry can use them)
  if ((industry.formats || []).includes('social_post') || (industry.formats || []).includes('meta_ad')) {
    const regionLabel = `${region.label}`;
    const r = await GOOGLE_PLACES_COHORT.fetch({
      industryKeyword: industry.label,
      regionLabel,
      regionCode: regionId,
      businessLimit: options.placesBusinessLimit || 6,
    });
    if (r.ok && Array.isArray(r.reviews)) {
      stats.examples_fetched += r.reviews.length;
      for (const review of r.reviews) {
        const existed = await _alreadyExists({
          sbGet,
          source: 'google_places_cohort',
          sourceRef: review.source_ref,
        });
        if (existed) {
          stats.examples_skipped++;
          continue;
        }
        const processed = await _processAndPersist({
          rawRow: { ...review, source: 'google_places_cohort' },
          industryHint: industryId,
          regionHint: regionId,
          formatHint: 'review',
          deps,
          stats,
        });
        if (processed) stats.examples_kept++;
      }
    }
  }

  await _endRun({
    sbPatch,
    runId,
    stats: {
      ...stats,
      status: 'ok',
    },
  });

  if (metrics?.increment) {
    metrics.increment('pretrainer_cohorts_total', { industry: industryId, region: regionId });
    metrics.increment('pretrainer_examples_kept_total', { industry: industryId }, stats.examples_kept);
  }

  return { ok: true, run_id: runId, ...stats };
}

/**
 * The per-row classify + score + embed + insert pipeline.
 */
async function _processAndPersist({ rawRow, industryHint, regionHint, formatHint, deps, stats }) {
  const { callClaude, sbPost, logger } = deps;
  const providers = require('../../lib/embeddingProviders');

  // 1. Classify
  const classification = await classifier.classify({
    callClaude,
    row: rawRow,
    formatHint,
  });
  stats.cost_usd_cents += HAIKU_COST_PER_CLASSIFICATION_CENTS;

  // If classifier disagrees with our hint, trust it (it actually read the body)
  const finalIndustry = classification?.industry || industryHint || 'smb_general';
  const finalFormat = classification?.format || formatHint || 'meta_ad';
  const finalLanguage = classification?.language || rawRow.language || null;

  // 2. Quality score
  const allBrands = expertSources.getAllExpertBrands();
  const { qualityScore, signals } = qualityScorer.score(rawRow, { expertBrandsLookup: allBrands });
  const outcomeLabel = qualityScorer.toOutcomeLabel(qualityScore);

  // Wave 59 S1: hard quality floor — drop sub-threshold rows entirely
  // (no DB write, no embedding cost). Saves storage and prevents mediocre
  // examples from polluting retrieval results.
  if (!qualityScorer.isAcceptable(qualityScore)) {
    if (stats) stats.examples_skipped = (stats.examples_skipped || 0) + 1;
    return false;
  }

  // 3. Embed (single text — title + body works well for retrieval)
  const embedInput = [rawRow.title, rawRow.body].filter(Boolean).join('\n').slice(0, 8000);
  let embeddingArr = null;
  try {
    const e = await providers.embed(embedInput);
    if (e) embeddingArr = Array.from(e);
    stats.cost_usd_cents += EMBEDDING_COST_PER_CALL_CENTS;
  } catch (e) {
    logger?.warn?.('pretrainer.embed', null, 'embed failed', { error: e.message });
  }

  // 4. Persist
  const row = {
    source: rawRow.source,
    source_url: rawRow.source_url || null,
    source_ref: rawRow.source_ref || null,
    industry: finalIndustry,
    sub_industry: industryHint && industryHint !== finalIndustry ? industryHint : null,
    region: regionHint,
    locale: finalLanguage ? `${finalLanguage}-${regionHint}` : null,
    format: finalFormat,
    title: rawRow.title || null,
    body: rawRow.body,
    cta: rawRow.cta || null,
    visual_brief: rawRow.visual_brief || null,
    language: finalLanguage,
    quality_score: qualityScore,
    quality_signals: signals,
    outcome_label: outcomeLabel,
    embedding: embeddingArr,
    taxonomy_version: 'v1',
    metadata: {
      classifier_confidence: classification?.confidence ?? null,
      runtime_days: rawRow.runtime_days ?? null,
      page_name: rawRow.page_name ?? null,
    },
  };

  return _insertRow({ sbPost, row, logger });
}

/**
 * Sweep the full taxonomy. Use sparingly — this is the seed/refresh run.
 * Caps total examples across all cohorts to prevent runaway cost.
 */
async function runForAll({ deps, options = {} } = {}) {
  if (!deps?.callClaude || !deps?.sbGet || !deps?.sbPost) {
    return { ok: false, reason: 'deps required' };
  }
  const totalCapExamples = options.totalCapExamples || 50_000;
  const targetIndustries = options.industries || industries.getAllIds();
  const targetRegions = options.regions || ['US', 'GB', 'AU', 'CA', 'DE', 'FR', 'AL', 'GLOBAL'];

  let totalKept = 0;
  let totalCostCents = 0;
  const cohortResults = [];

  for (const industryId of targetIndustries) {
    for (const regionId of targetRegions) {
      if (totalKept >= totalCapExamples) {
        return {
          ok: true,
          reason: 'totalCapExamples reached',
          total_kept: totalKept,
          total_cost_usd_cents: totalCostCents,
          cohorts: cohortResults,
        };
      }
      const r = await runForCohort({ industryId, regionId, deps, options });
      if (r.ok) {
        totalKept += r.examples_kept || 0;
        totalCostCents += r.cost_usd_cents || 0;
      }
      cohortResults.push({ industryId, regionId, ...r });
    }
  }

  return {
    ok: true,
    total_kept: totalKept,
    total_cost_usd_cents: totalCostCents,
    cohorts: cohortResults,
  };
}

module.exports = {
  runForCohort,
  runForAll,
  _aggregateRegionToCountries,
  _processAndPersist,
};
