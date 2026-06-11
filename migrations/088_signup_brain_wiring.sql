-- Migration 088 — signup → brain wiring (reference images, logo, website enrichment)
-- Adds the columns behind three onboarding capabilities so the brain actually
-- USES what the customer provides, instead of storing it and ignoring it:
--
--   • product_image_urls — hosted URLs of the customer's product/shop photos.
--     WF1 passes one as the Higgsfield reference image (image_url / sourceImageUrl)
--     so generated content riffs on their real products, not generic stock.
--   • logo_url — the customer's logo. Threaded into the visual brief as a brand
--     asset. NOTE: Higgsfield reference != pixel-accurate overlay; true logo
--     placement still needs a compositing step (documented limitation).
--   • website_summary / website_enriched_at — Claude's structured read of the
--     customer's homepage (see lib/websiteEnricher.js), injected into the brand
--     context so the brain "knows the business from the website".

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS product_image_urls JSONB DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_summary TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website_enriched_at TIMESTAMPTZ;
