#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * Seed industry_benchmarks with publicly cited SMB marketing averages.
 * Idempotent upsert on (industry, region).
 *
 * Usage: SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-industry-benchmarks.js
 */

const { getSeedConfig, sbUpsert } = require('./lib/seedSupabase');

const DRY_RUN = process.argv.includes('--dry-run');

const BENCHMARKS = [
  {
    industry: 'dental',
    meta_avg_ctr: 0.009,
    google_avg_cpc_usd: 4.5,
    email_open_rate: 0.22,
    best_days_post: ['Tuesday', 'Wednesday', 'Thursday'],
    best_times_post: ['09:00', '12:00', '17:00'],
    instagram_engagement_rate: 0.018,
    top_content_types: ['before_after', 'patient_stories', 'educational_carousel', 'team_intro'],
  },
  {
    industry: 'restaurant',
    meta_avg_ctr: 0.012,
    google_avg_cpc_usd: 2.1,
    email_open_rate: 0.19,
    best_days_post: ['Thursday', 'Friday', 'Saturday'],
    best_times_post: ['11:30', '17:00', '19:00'],
    instagram_engagement_rate: 0.025,
    top_content_types: ['dish_hero', 'behind_the_kitchen', 'ugc_reviews', 'limited_menu_drop'],
  },
  {
    industry: 'retail',
    meta_avg_ctr: 0.011,
    google_avg_cpc_usd: 1.35,
    email_open_rate: 0.18,
    best_days_post: ['Wednesday', 'Thursday', 'Sunday'],
    best_times_post: ['10:00', '14:00', '20:00'],
    instagram_engagement_rate: 0.014,
    top_content_types: ['product_drop', 'styling_flat_lay', 'sale_countdown', 'customer_try_on'],
  },
  {
    industry: 'fitness',
    meta_avg_ctr: 0.013,
    google_avg_cpc_usd: 3.2,
    email_open_rate: 0.21,
    best_days_post: ['Monday', 'Wednesday', 'Sunday'],
    best_times_post: ['06:00', '12:00', '18:00'],
    instagram_engagement_rate: 0.032,
    top_content_types: ['transformation', 'class_clip', 'trainer_tip', 'member_spotlight'],
  },
  {
    industry: 'beauty',
    meta_avg_ctr: 0.014,
    google_avg_cpc_usd: 2.8,
    email_open_rate: 0.2,
    best_days_post: ['Tuesday', 'Friday', 'Saturday'],
    best_times_post: ['10:00', '13:00', '19:00'],
    instagram_engagement_rate: 0.028,
    top_content_types: ['before_after', 'tutorial_reel', 'product_texture', 'stylist_portfolio'],
  },
  {
    industry: 'legal',
    meta_avg_ctr: 0.007,
    google_avg_cpc_usd: 8.5,
    email_open_rate: 0.24,
    best_days_post: ['Tuesday', 'Wednesday'],
    best_times_post: ['08:00', '12:00'],
    instagram_engagement_rate: 0.009,
    top_content_types: ['faq_carousel', 'case_outcome', 'founder_authority', 'local_seo_tip'],
  },
  {
    industry: 'real_estate',
    meta_avg_ctr: 0.01,
    google_avg_cpc_usd: 3.75,
    email_open_rate: 0.17,
    best_days_post: ['Thursday', 'Friday', 'Saturday'],
    best_times_post: ['09:00', '18:00'],
    instagram_engagement_rate: 0.016,
    top_content_types: ['listing_walkthrough', 'neighborhood_guide', 'market_update', 'client_testimonial'],
  },
  {
    industry: 'ecommerce',
    meta_avg_ctr: 0.015,
    google_avg_cpc_usd: 1.15,
    email_open_rate: 0.16,
    best_days_post: ['Tuesday', 'Thursday', 'Sunday'],
    best_times_post: ['12:00', '20:00'],
    instagram_engagement_rate: 0.012,
    top_content_types: ['ugc_unboxing', 'product_demo', 'social_proof_review', 'flash_sale'],
  },
  {
    industry: 'cafe',
    meta_avg_ctr: 0.012,
    google_avg_cpc_usd: 1.85,
    email_open_rate: 0.2,
    best_days_post: ['Tuesday', 'Friday', 'Saturday'],
    best_times_post: ['07:30', '12:00', '16:00'],
    instagram_engagement_rate: 0.022,
    top_content_types: ['latte_art', 'morning_ritual', 'seasonal_drink', 'barista_story'],
  },
];

async function main() {
  if (!getSeedConfig().ok && !DRY_RUN) {
    console.error('[seed-benchmarks] Need SUPABASE_URL + SUPABASE_KEY');
    process.exit(1);
  }

  const rows = BENCHMARKS.map((b) => ({
    industry: b.industry,
    region: 'GLOBAL',
    meta_avg_ctr: b.meta_avg_ctr,
    google_avg_cpc_usd: b.google_avg_cpc_usd,
    email_open_rate: b.email_open_rate,
    best_days_post: b.best_days_post,
    best_times_post: b.best_times_post,
    instagram_engagement_rate: b.instagram_engagement_rate,
    top_content_types: b.top_content_types,
    benchmarks: b,
    source: 'public_benchmarks_2026',
    updated_at: new Date().toISOString(),
  }));

  if (DRY_RUN) {
    console.log(`[seed-benchmarks] would upsert ${rows.length} industries`);
    rows.forEach((r) => console.log(`  - ${r.industry} CTR ${(r.meta_avg_ctr * 100).toFixed(2)}%`));
    return;
  }

  const result = await sbUpsert('industry_benchmarks', rows, 'industry,region');
  const n = Array.isArray(result) ? result.length : rows.length;
  console.log(`[seed-benchmarks] upserted ${n} industry rows`);
}

main().catch((e) => {
  console.error('[seed-benchmarks] failed:', e.message);
  process.exit(1);
});
