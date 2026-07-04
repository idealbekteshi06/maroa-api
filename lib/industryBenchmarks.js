'use strict';

/**
 * lib/industryBenchmarks.js — calibrated static benchmark table (2026-07).
 *
 * The industry_benchmarks DB table shipped with ZERO seed rows, so every
 * benchmark lookup returned null and the ad-optimizer audited blind ("never
 * call CTR low without citing the regional benchmark" — with no benchmark to
 * cite). This module fixes that two ways:
 *
 *   1. In code: groundingContext.fetchIndustryBenchmarks falls back here when
 *      the DB row is missing — benchmarks work with no migration applied.
 *   2. In DB: migration 101 seeds the same values so PostgREST reads,
 *      operator edits, and future per-region refinements stay possible.
 *
 * Values are mid-range figures from public 2024–2025 benchmark reports
 * (LocaliQ/WordStream search advertising benchmarks, Meta CTR studies,
 * Mailchimp/Klaviyo email benchmarks, Rival IQ social engagement). They are
 * calibration anchors for small-business accounts ($5–$500/day), not
 * guarantees — the ad-optimizer treats them as comparison context, and rows
 * carry `source` so a future live-data refresh can supersede them.
 *
 * Shape mirrors the industry_benchmarks table exactly (fetchIndustryBenchmarks
 * consumers read these columns).
 */

const SOURCE = 'public_benchmarks_2026_static';

// industry → row (region GLOBAL). Rates are fractions (0.014 = 1.4%).
const BENCHMARKS = {
  global: {
    meta_avg_ctr: 0.014,
    google_avg_cpc_usd: 4.66,
    email_open_rate: 0.36,
    instagram_engagement_rate: 0.007,
    best_days_post: ['tuesday', 'wednesday', 'thursday'],
    best_times_post: ['09:00', '12:00', '19:00'],
    benchmarks: { meta_cpm_usd: 12.5, meta_conversion_rate: 0.09, google_search_ctr: 0.063 },
  },
  dental: {
    meta_avg_ctr: 0.013,
    google_avg_cpc_usd: 6.82,
    email_open_rate: 0.37,
    instagram_engagement_rate: 0.006,
    best_days_post: ['monday', 'tuesday', 'wednesday'],
    best_times_post: ['08:00', '12:00', '17:00'],
    benchmarks: { meta_cpm_usd: 13.8, meta_conversion_rate: 0.11, google_search_ctr: 0.055 },
  },
  restaurant: {
    meta_avg_ctr: 0.017,
    google_avg_cpc_usd: 2.18,
    email_open_rate: 0.4,
    instagram_engagement_rate: 0.011,
    best_days_post: ['thursday', 'friday', 'saturday'],
    best_times_post: ['11:00', '17:00', '19:30'],
    benchmarks: { meta_cpm_usd: 9.2, meta_conversion_rate: 0.07, google_search_ctr: 0.081 },
  },
  retail: {
    meta_avg_ctr: 0.016,
    google_avg_cpc_usd: 2.71,
    email_open_rate: 0.35,
    instagram_engagement_rate: 0.006,
    best_days_post: ['wednesday', 'friday', 'sunday'],
    best_times_post: ['10:00', '13:00', '20:00'],
    benchmarks: { meta_cpm_usd: 10.4, meta_conversion_rate: 0.08, google_search_ctr: 0.072 },
  },
  fitness: {
    meta_avg_ctr: 0.015,
    google_avg_cpc_usd: 4.71,
    email_open_rate: 0.39,
    instagram_engagement_rate: 0.009,
    best_days_post: ['monday', 'tuesday', 'saturday'],
    best_times_post: ['06:30', '12:00', '18:00'],
    benchmarks: { meta_cpm_usd: 11.6, meta_conversion_rate: 0.1, google_search_ctr: 0.067 },
  },
  beauty: {
    meta_avg_ctr: 0.016,
    google_avg_cpc_usd: 5.04,
    email_open_rate: 0.36,
    instagram_engagement_rate: 0.008,
    best_days_post: ['tuesday', 'thursday', 'sunday'],
    best_times_post: ['10:00', '14:00', '19:00'],
    benchmarks: { meta_cpm_usd: 12.1, meta_conversion_rate: 0.09, google_search_ctr: 0.061 },
  },
  legal: {
    meta_avg_ctr: 0.011,
    google_avg_cpc_usd: 8.94,
    email_open_rate: 0.36,
    instagram_engagement_rate: 0.004,
    best_days_post: ['monday', 'tuesday', 'wednesday'],
    best_times_post: ['08:30', '12:00', '16:00'],
    benchmarks: { meta_cpm_usd: 15.7, meta_conversion_rate: 0.07, google_search_ctr: 0.046 },
  },
  real_estate: {
    meta_avg_ctr: 0.019,
    google_avg_cpc_usd: 2.1,
    email_open_rate: 0.37,
    instagram_engagement_rate: 0.007,
    best_days_post: ['thursday', 'friday', 'saturday'],
    best_times_post: ['09:00', '13:00', '18:30'],
    benchmarks: { meta_cpm_usd: 10.9, meta_conversion_rate: 0.1, google_search_ctr: 0.087 },
  },
  ecommerce: {
    meta_avg_ctr: 0.015,
    google_avg_cpc_usd: 1.86,
    email_open_rate: 0.34,
    instagram_engagement_rate: 0.005,
    best_days_post: ['wednesday', 'friday', 'sunday'],
    best_times_post: ['12:00', '15:00', '21:00'],
    benchmarks: { meta_cpm_usd: 9.8, meta_conversion_rate: 0.025, google_search_ctr: 0.069 },
  },
  cafe: {
    meta_avg_ctr: 0.017,
    google_avg_cpc_usd: 2.05,
    email_open_rate: 0.4,
    instagram_engagement_rate: 0.012,
    best_days_post: ['friday', 'saturday', 'sunday'],
    best_times_post: ['07:30', '10:00', '15:00'],
    benchmarks: { meta_cpm_usd: 8.9, meta_conversion_rate: 0.06, google_search_ctr: 0.083 },
  },
  home_services: {
    meta_avg_ctr: 0.012,
    google_avg_cpc_usd: 7.11,
    email_open_rate: 0.38,
    instagram_engagement_rate: 0.005,
    best_days_post: ['monday', 'tuesday', 'thursday'],
    best_times_post: ['08:00', '12:00', '18:00'],
    benchmarks: { meta_cpm_usd: 14.2, meta_conversion_rate: 0.12, google_search_ctr: 0.051 },
  },
  healthcare: {
    meta_avg_ctr: 0.012,
    google_avg_cpc_usd: 5.28,
    email_open_rate: 0.39,
    instagram_engagement_rate: 0.005,
    best_days_post: ['monday', 'wednesday', 'thursday'],
    best_times_post: ['08:00', '12:30', '17:00'],
    benchmarks: { meta_cpm_usd: 13.1, meta_conversion_rate: 0.1, google_search_ctr: 0.052 },
  },
  automotive: {
    meta_avg_ctr: 0.014,
    google_avg_cpc_usd: 2.63,
    email_open_rate: 0.35,
    instagram_engagement_rate: 0.006,
    best_days_post: ['tuesday', 'thursday', 'saturday'],
    best_times_post: ['09:00', '13:00', '18:00'],
    benchmarks: { meta_cpm_usd: 11.2, meta_conversion_rate: 0.08, google_search_ctr: 0.06 },
  },
  saas: {
    meta_avg_ctr: 0.01,
    google_avg_cpc_usd: 7.68,
    email_open_rate: 0.33,
    instagram_engagement_rate: 0.004,
    best_days_post: ['tuesday', 'wednesday', 'thursday'],
    best_times_post: ['09:30', '13:00', '16:00'],
    benchmarks: { meta_cpm_usd: 16.3, meta_conversion_rate: 0.05, google_search_ctr: 0.038 },
  },
  education: {
    meta_avg_ctr: 0.014,
    google_avg_cpc_usd: 4.31,
    email_open_rate: 0.38,
    instagram_engagement_rate: 0.007,
    best_days_post: ['monday', 'wednesday', 'sunday'],
    best_times_post: ['10:00', '15:00', '20:00'],
    benchmarks: { meta_cpm_usd: 11.9, meta_conversion_rate: 0.09, google_search_ctr: 0.058 },
  },
  travel: {
    meta_avg_ctr: 0.018,
    google_avg_cpc_usd: 1.92,
    email_open_rate: 0.37,
    instagram_engagement_rate: 0.009,
    best_days_post: ['wednesday', 'friday', 'sunday'],
    best_times_post: ['11:00', '16:00', '20:30'],
    benchmarks: { meta_cpm_usd: 9.5, meta_conversion_rate: 0.04, google_search_ctr: 0.079 },
  },
};

/**
 * Static-table lookup shaped exactly like an industry_benchmarks row so
 * formatBenchmarkComparison / postingScheduleFromBenchmark consume it as-is.
 * Returns null only for unknown slugs (callers then use their global path).
 */
function staticBenchmarkRow(industrySlug, region = 'GLOBAL') {
  const key = String(industrySlug || 'global').toLowerCase();
  const row = BENCHMARKS[key];
  if (!row) return null;
  return {
    industry: key,
    region,
    ...row,
    top_content_types: [],
    source: SOURCE,
  };
}

module.exports = { BENCHMARKS, staticBenchmarkRow, SOURCE };
