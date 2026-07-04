-- 101_seed_industry_benchmarks.sql
-- Seeds industry_benchmarks (migration 085 created it EMPTY — every lookup
-- returned null and the ad-optimizer audited benchmark-blind). Values are
-- mid-range public 2024-2025 benchmark figures (LocaliQ/WordStream, Meta CTR
-- studies, Mailchimp email, Rival IQ social) mirrored from
-- lib/industryBenchmarks.js — keep the two in sync.

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('global', 'GLOBAL', 0.014, 4.66, 0.36, 0.007, '{tuesday,wednesday,thursday}', '{09:00,12:00,19:00}', '{"meta_cpm_usd":12.5,"meta_conversion_rate":0.09,"google_search_ctr":0.063}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('dental', 'GLOBAL', 0.013, 6.82, 0.37, 0.006, '{monday,tuesday,wednesday}', '{08:00,12:00,17:00}', '{"meta_cpm_usd":13.8,"meta_conversion_rate":0.11,"google_search_ctr":0.055}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('restaurant', 'GLOBAL', 0.017, 2.18, 0.4, 0.011, '{thursday,friday,saturday}', '{11:00,17:00,19:30}', '{"meta_cpm_usd":9.2,"meta_conversion_rate":0.07,"google_search_ctr":0.081}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('retail', 'GLOBAL', 0.016, 2.71, 0.35, 0.006, '{wednesday,friday,sunday}', '{10:00,13:00,20:00}', '{"meta_cpm_usd":10.4,"meta_conversion_rate":0.08,"google_search_ctr":0.072}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('fitness', 'GLOBAL', 0.015, 4.71, 0.39, 0.009, '{monday,tuesday,saturday}', '{06:30,12:00,18:00}', '{"meta_cpm_usd":11.6,"meta_conversion_rate":0.1,"google_search_ctr":0.067}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('beauty', 'GLOBAL', 0.016, 5.04, 0.36, 0.008, '{tuesday,thursday,sunday}', '{10:00,14:00,19:00}', '{"meta_cpm_usd":12.1,"meta_conversion_rate":0.09,"google_search_ctr":0.061}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('legal', 'GLOBAL', 0.011, 8.94, 0.36, 0.004, '{monday,tuesday,wednesday}', '{08:30,12:00,16:00}', '{"meta_cpm_usd":15.7,"meta_conversion_rate":0.07,"google_search_ctr":0.046}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('real_estate', 'GLOBAL', 0.019, 2.1, 0.37, 0.007, '{thursday,friday,saturday}', '{09:00,13:00,18:30}', '{"meta_cpm_usd":10.9,"meta_conversion_rate":0.1,"google_search_ctr":0.087}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('ecommerce', 'GLOBAL', 0.015, 1.86, 0.34, 0.005, '{wednesday,friday,sunday}', '{12:00,15:00,21:00}', '{"meta_cpm_usd":9.8,"meta_conversion_rate":0.025,"google_search_ctr":0.069}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('cafe', 'GLOBAL', 0.017, 2.05, 0.4, 0.012, '{friday,saturday,sunday}', '{07:30,10:00,15:00}', '{"meta_cpm_usd":8.9,"meta_conversion_rate":0.06,"google_search_ctr":0.083}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('home_services', 'GLOBAL', 0.012, 7.11, 0.38, 0.005, '{monday,tuesday,thursday}', '{08:00,12:00,18:00}', '{"meta_cpm_usd":14.2,"meta_conversion_rate":0.12,"google_search_ctr":0.051}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('healthcare', 'GLOBAL', 0.012, 5.28, 0.39, 0.005, '{monday,wednesday,thursday}', '{08:00,12:30,17:00}', '{"meta_cpm_usd":13.1,"meta_conversion_rate":0.1,"google_search_ctr":0.052}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('automotive', 'GLOBAL', 0.014, 2.63, 0.35, 0.006, '{tuesday,thursday,saturday}', '{09:00,13:00,18:00}', '{"meta_cpm_usd":11.2,"meta_conversion_rate":0.08,"google_search_ctr":0.06}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('saas', 'GLOBAL', 0.01, 7.68, 0.33, 0.004, '{tuesday,wednesday,thursday}', '{09:30,13:00,16:00}', '{"meta_cpm_usd":16.3,"meta_conversion_rate":0.05,"google_search_ctr":0.038}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('education', 'GLOBAL', 0.014, 4.31, 0.38, 0.007, '{monday,wednesday,sunday}', '{10:00,15:00,20:00}', '{"meta_cpm_usd":11.9,"meta_conversion_rate":0.09,"google_search_ctr":0.058}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();

INSERT INTO industry_benchmarks (industry, region, meta_avg_ctr, google_avg_cpc_usd, email_open_rate, instagram_engagement_rate, best_days_post, best_times_post, benchmarks, source)
VALUES ('travel', 'GLOBAL', 0.018, 1.92, 0.37, 0.009, '{wednesday,friday,sunday}', '{11:00,16:00,20:30}', '{"meta_cpm_usd":9.5,"meta_conversion_rate":0.04,"google_search_ctr":0.079}'::jsonb, 'public_benchmarks_2026_static')
ON CONFLICT (industry, region) DO UPDATE SET
  meta_avg_ctr = EXCLUDED.meta_avg_ctr,
  google_avg_cpc_usd = EXCLUDED.google_avg_cpc_usd,
  email_open_rate = EXCLUDED.email_open_rate,
  instagram_engagement_rate = EXCLUDED.instagram_engagement_rate,
  best_days_post = EXCLUDED.best_days_post,
  best_times_post = EXCLUDED.best_times_post,
  benchmarks = EXCLUDED.benchmarks,
  source = EXCLUDED.source,
  updated_at = now();
