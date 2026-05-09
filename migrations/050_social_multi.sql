-- migrations/050_social_multi.sql
-- Week 11 — Multi-platform social posting via Ayrshare aggregator
-- ---------------------------------------------------------------------------

-- Ayrshare per-business profile key (subaccounts are how Ayrshare handles
-- multi-tenant), plus list of platforms the customer has connected
-- inside Ayrshare's UI.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS ayrshare_profile_key text;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS ayrshare_connected_platforms text[]
  DEFAULT ARRAY[]::text[];

-- Threads is a Meta property; we store its ID in the same family as IG/FB.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS threads_account_id text;

COMMENT ON COLUMN businesses.ayrshare_profile_key IS
  'Per-business Ayrshare sub-account key. Customers OAuth into LinkedIn / Pinterest / TikTok / YouTube via Ayrshare''s flow; we store the resulting profile key here.';
COMMENT ON COLUMN businesses.ayrshare_connected_platforms IS
  'Mirror of which platforms the customer connected inside Ayrshare. Prevents posting attempts to disconnected platforms.';
