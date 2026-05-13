'use strict';

/**
 * services/public-pretrainer/quality-scorer.js
 * ---------------------------------------------------------------------------
 * Heuristic quality scorer for corpus rows. Assigns a 0.0–1.0 score that
 * downstream retrieval uses as a filter (`quality_score >= 0.6` by default).
 *
 * Why heuristics (vs. an LLM judge): we score ~500k–1M examples during
 * pre-training seed. A Haiku judge call per example would cost ~$50. Heuristic
 * scoring is free and good enough for first-pass filtering. The Critic loop
 * (lib/adversarialCritic.js) provides quality QA at retrieval time, where it
 * matters.
 *
 * Signals (each contributes 0.0–0.3 to the final score):
 *   - runtime         long-running ads = working ads (max +0.3)
 *   - source_authority award/publication source = trusted (+0.25)
 *   - brand_curated   listed in expert_sources.js (+0.2)
 *   - content_quality length + specificity heuristics (+0.15)
 *   - rating          for reviews: 5-star vs 1-star (+0.1)
 *
 * Floor: 0.3 (we don't drop anything below 0.3 outright — the corpus
 * retrieval filter applies `>= 0.6` so weaker rows just don't surface,
 * but stay available for future use).
 */

const FLOOR = 0.3;
const CEIL = 1.0;

// ─── Wave 59 S1: hard quality floor ────────────────────────────────────
// Rows scoring below ACCEPTABLE_THRESHOLD are dropped entirely from the
// corpus, not stored at low score. This is the "aggressive cross-filter"
// — better an empty corpus than a corpus full of mediocre examples
// that train the system to imitate them.
const ACCEPTABLE_THRESHOLD = 0.55;

// ─── Wave 59 S1: award-winner boost ────────────────────────────────────
// Brands in expert_sources.AWARD_WINNERS get bumped to AWARD_TIER_SCORE
// regardless of other signals. Awards = proven craft, the tightest
// available quality signal.
const AWARD_TIER_SCORE = 0.95;

// ─── Wave 59 S1: long-runtime boost ────────────────────────────────────
// Ads running 60+ days have survived split-testing — they're profitable
// even without seeing the engagement signal directly.
const LONG_RUNTIME_DAYS = 60;
const LONG_RUNTIME_FLOOR = 0.8;

const AI_TELLS = [
  // Common AI-coded phrases that signal generic / synthetic copy
  'delve',
  'unlock',
  'revolutionize',
  'leverage',
  'empower',
  'seamlessly',
  "in today's",
  'cutting-edge',
  'best-in-class',
  'state-of-the-art',
  'world-class',
  'unparalleled',
];

const SPECIFICITY_SIGNALS = [
  // Real numbers in copy are strong specificity signals
  /\b\d{2,}\b/, // 2+ digit number
  /\$\d+/, // dollar amounts
  /\d+%/, // percentages
  /\d+x/i, // multipliers (5x, 10x)
  /\d+\+/, // approximate counts (1000+)
];

/**
 * Score the runtime signal. Long-running ads have survived split testing,
 * which is the closest free public proxy for "this ad works".
 *
 * @param {number|null} runtimeDays days the ad has been live
 */
function _scoreRuntime(runtimeDays) {
  if (typeof runtimeDays !== 'number' || runtimeDays <= 0) return 0;
  if (runtimeDays >= 90) return 0.3;
  if (runtimeDays >= 30) return 0.2;
  if (runtimeDays >= 14) return 0.1;
  return 0.05;
}

/**
 * Score source authority. Award archives + reputable publications get +0.25.
 */
function _scoreSourceAuthority(source) {
  if (!source) return 0;
  if (source === 'manual_curation') return 0.25; // Implies human curation
  if (source === 'really_good_emails') return 0.2;
  if (source === 'marketing_examined') return 0.2;
  return 0;
}

/**
 * Score brand-curated tier. If the page name is in our expert_sources.js
 * catalog, the example is from a brand known to spend $10M+/year on ads.
 */
function _scoreBrandCurated({ pageName, expertBrandsLookup }) {
  if (!pageName || !expertBrandsLookup) return 0;
  const normalized = String(pageName).toLowerCase().trim();
  for (const brand of expertBrandsLookup) {
    const brandName = String(brand.name || '')
      .toLowerCase()
      .trim();
    if (!brandName) continue;
    if (normalized === brandName || normalized.includes(brandName) || brandName.includes(normalized)) {
      return Math.max(0.15, Math.min(0.2, brand.qualityScore - 0.7));
    }
  }
  return 0;
}

/**
 * Score the content itself — length, specificity, AI-tell penalties.
 */
function _scoreContentQuality(body) {
  if (!body || typeof body !== 'string') return 0;
  const text = body.toLowerCase();
  const wordCount = body.trim().split(/\s+/).length;

  let score = 0;

  // Length sweet spot: 15-150 words. Too short = no info; too long = wall of text.
  if (wordCount >= 15 && wordCount <= 150) score += 0.08;
  else if (wordCount >= 8 && wordCount < 15) score += 0.04;
  else if (wordCount > 150 && wordCount <= 300) score += 0.04;

  // Specificity bonus
  for (const pat of SPECIFICITY_SIGNALS) {
    if (pat.test(body)) {
      score += 0.03;
      break;
    }
  }

  // AI-tell penalty — every hit deducts 0.02 down to 0
  let penalty = 0;
  for (const tell of AI_TELLS) {
    if (text.includes(tell)) penalty += 0.02;
  }
  score = Math.max(0, score - Math.min(penalty, 0.1));

  return Math.min(0.15, score);
}

/**
 * Score the review rating signal.
 */
function _scoreRating(rating) {
  if (typeof rating !== 'number') return 0;
  if (rating >= 5) return 0.1;
  if (rating >= 4) return 0.08;
  if (rating >= 3) return 0.04;
  if (rating >= 2) return 0.02;
  return 0;
}

/**
 * Main entrypoint. Returns { qualityScore, signals } so we can record what
 * drove the score (useful for debugging + auditing the corpus quality).
 */
function score(row, { expertBrandsLookup } = {}) {
  if (!row || typeof row !== 'object') {
    return { qualityScore: FLOOR, signals: { reason: 'invalid input' } };
  }

  const runtime = _scoreRuntime(row.runtime_days);
  const authority = _scoreSourceAuthority(row.source);
  const brand = _scoreBrandCurated({ pageName: row.page_name, expertBrandsLookup });
  const content = _scoreContentQuality(row.body);
  const rating = _scoreRating(row.rating);

  // Heuristic-weighted aggregate. Each signal has a max, sum capped at CEIL.
  let total = FLOOR + runtime + authority + brand + content + rating;
  total = Math.max(FLOOR, Math.min(CEIL, total));

  // ─── Wave 59 S1: tier-based promotions ────────────────────────────
  // Award winners always get AWARD_TIER_SCORE (overrides heuristic
  // aggregate). Long-running ads get LONG_RUNTIME_FLOOR if heuristic
  // is lower. Both stack with the existing brand-curated boost.
  let isAwardWinner = false;
  try {
    const expertSources = require('../../lib/taxonomy/expert_sources');
    isAwardWinner = expertSources.isAwardWinner(row.page_name);
  } catch {
    /* taxonomy unavailable — fall back to heuristic only */
  }
  if (isAwardWinner) {
    total = Math.max(total, AWARD_TIER_SCORE);
  } else if (typeof row.runtime_days === 'number' && row.runtime_days >= LONG_RUNTIME_DAYS) {
    total = Math.max(total, LONG_RUNTIME_FLOOR);
  }

  return {
    qualityScore: Number(total.toFixed(3)),
    signals: {
      runtime,
      authority,
      brand,
      content,
      rating,
      award_winner: isAwardWinner,
      long_runtime: typeof row.runtime_days === 'number' && row.runtime_days >= LONG_RUNTIME_DAYS,
      runtime_days: row.runtime_days,
      source: row.source,
      page_name: row.page_name,
    },
  };
}

/**
 * Wave 59 S1: hard quality filter. Rows below ACCEPTABLE_THRESHOLD are
 * dropped before they ever hit the classifier or the DB. Saves Haiku +
 * embedding cost and prevents mediocre examples from polluting retrieval.
 *
 * Returns true if the row should be KEPT, false to drop.
 */
function isAcceptable(qualityScore) {
  return typeof qualityScore === 'number' && qualityScore >= ACCEPTABLE_THRESHOLD;
}

/**
 * Map a numeric quality score to a categorical outcome label
 * for `marketing_corpus.outcome_label`. Used by the orchestrator.
 */
function toOutcomeLabel(qualityScore) {
  if (qualityScore >= 0.75) return 'high';
  if (qualityScore >= 0.5) return 'medium';
  return 'low';
}

module.exports = {
  score,
  toOutcomeLabel,
  isAcceptable,
  FLOOR,
  CEIL,
  ACCEPTABLE_THRESHOLD,
  AWARD_TIER_SCORE,
  LONG_RUNTIME_DAYS,
  LONG_RUNTIME_FLOOR,
  AI_TELLS,
};
