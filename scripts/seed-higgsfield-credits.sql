-- scripts/seed-higgsfield-credits.sql
-- ---------------------------------------------------------------------------
-- One-off ops script: seed a test business's Higgsfield credit balance so the
-- low-balance alert pipeline (daily 07:00 UTC checkHiggsfieldCredits cron →
-- /webhook/check-higgsfield-credits) can be verified end-to-end before the
-- real Higgsfield balance REST endpoint is wired.
--
-- Context: services/higgsfield/index.js getBalance() is still a stub, so
-- businesses.higgsfield_credits is never written automatically yet. Seeding
-- it by hand proves the DOWNSTREAM half (guard + alert email) works.
--
-- The WF1 engine HARD-BLOCKS generation when higgsfield_credits < 100; the
-- daily cron EMAILS the owner when < 200. 150 lands in the alert band but
-- above the hard block, so generation continues + an alert fires.
--
-- Run in the Supabase SQL editor (project zqhyrbttuqkvmdewiytf) or via:
--   psql "$SUPABASE_DB_URL" -f scripts/seed-higgsfield-credits.sql
-- ---------------------------------------------------------------------------

-- 1) Seed the test business (idealbekteshi06 / ibgboost.com).
UPDATE businesses
   SET higgsfield_credits = 150,
       higgsfield_credits_checked_at = now()
 WHERE email = 'idealbekteshi06@gmail.com';

-- 2) Confirm the seed landed.
SELECT id, business_name, email, higgsfield_credits, higgsfield_credits_checked_at
  FROM businesses
 WHERE email = 'idealbekteshi06@gmail.com';

-- 3) Migration 087 acceptance check — all 5 new businesses columns exist.
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'businesses'
   AND column_name IN (
     'higgsfield_soul_id', 'higgsfield_element_ids', 'higgsfield_product_id',
     'higgsfield_credits', 'higgsfield_credits_checked_at'
   )
 ORDER BY column_name;  -- expect 5 rows

-- 4) Migration 087 acceptance check — all 4 new tables exist.
SELECT tablename
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN (
     'content_performance', 'video_clips', 'higgsfield_generations', 'higgsfield_presets'
   )
 ORDER BY tablename;  -- expect 4 rows
