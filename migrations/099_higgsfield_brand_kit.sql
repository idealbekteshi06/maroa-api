-- 099_higgsfield_brand_kit.sql
-- Higgsfield Marketing Studio brand kit binding (2026-07 upgrade).
-- ensureBrandKit() creates a Marketing Studio brand kit from logo_url +
-- product_image_urls + brand fields and persists the id here; DTC ad image
-- generation (ms_image) then folds logo/colors/fonts/tone into every prompt —
-- the first-party replacement for the migration-088 logo-as-prompt-cue path.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS higgsfield_brand_kit_id TEXT;

COMMENT ON COLUMN businesses.higgsfield_brand_kit_id IS
  'Higgsfield Marketing Studio brand kit id (services/higgsfield/marketingStudio.js ensureBrandKit). NULL until first DTC-ad generation or explicit kit sync.';
