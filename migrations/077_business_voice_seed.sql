-- migrations/077_business_voice_seed.sql
-- ----------------------------------------------------------------------------
-- Add `voice_seed` to businesses so the onboarding "paste 1–3 sample posts"
-- box actually persists. Pre-077 the frontend collected the field but the
-- backend silently dropped it — first-draft brand voice was a coin flip.
--
-- The column is text (could be a few thousand chars of pasted copy). Used
-- by lib/groundingContext.js as a brand-voice signal until the closed-loop
-- system accumulates real wins/losses for the business.
-- ----------------------------------------------------------------------------

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS voice_seed text;

COMMENT ON COLUMN businesses.voice_seed IS
  'Customer-pasted brand voice samples from onboarding. Plain text, may include multiple post excerpts. Read by lib/groundingContext to anchor day-1 generation when no published-content history exists yet.';
