-- Migration 095 — per-business ad-execution consent (ads_live)
--
-- WHY: every mutating ads call (Meta campaign create/update/pause, Google
-- PMax create/status/conversion upload) was dry-run gated by GLOBAL env
-- flags (META_AD_LAUNCH_LIVE / GOOGLE_ADS_LIVE). All-or-nothing: flipping
-- the env flag arms EVERY customer at once, so it stayed off and the
-- ad-optimizer's daily decisions never touched a real ad account.
--
-- ads_live=true is the customer's explicit "Maroa may launch and adjust my
-- ads without asking" consent (asked at onboarding, changeable in settings).
-- The app-side gate is: env flag OR businesses.ads_live — so the env flags
-- remain a global kill-switch/override and per-business consent arms
-- execution one customer at a time. Caps + anti-thrash still apply.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ads_live BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN businesses.ads_live IS
  'Customer consent for autonomous ad execution. Gate = META_AD_LAUNCH_LIVE/GOOGLE_ADS_LIVE env OR this flag (migration 095).';
