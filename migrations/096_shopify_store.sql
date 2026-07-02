-- Migration 096 — Shopify / store catalog ingestion
--
-- WHY: dropshipping + e-commerce customers paste their store URL and Maroa
-- ingests the product catalog (Shopify public /products.json, or generic-site
-- summary fallback via lib/websiteEnricher.js). Products feed the content
-- brain (grounded product-aware copy) and WF1's Higgsfield reference-image
-- path (businesses.product_image_urls, migration 088).
--
-- Writer/reader: services/shopify/index.js (routes/shopify.js is the HTTP
-- surface — /api/store/connect | /products | /sync | /automation).

CREATE TABLE IF NOT EXISTS store_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid REFERENCES businesses(id) ON DELETE CASCADE,
  external_id  text,
  title        text,
  description  text,
  price        numeric,
  currency     text,
  image_urls   jsonb DEFAULT '[]'::jsonb,
  product_url  text,
  vendor       text,
  tags         jsonb DEFAULT '[]'::jsonb,
  source       text DEFAULT 'shopify',
  synced_at    timestamptz DEFAULT now(),
  created_at   timestamptz DEFAULT now(),
  UNIQUE (business_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_store_products_business
  ON store_products (business_id);

-- RLS — same tenant-isolation pattern as migrations 091/092: service_role
-- does everything (the API server writes with the service key); the
-- dashboard's authenticated anon-key sessions may only READ rows whose
-- business they own. No authenticated write path — all mutations go
-- through the API.
ALTER TABLE store_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "store_products_service_all" ON store_products;
CREATE POLICY "store_products_service_all" ON store_products
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "store_products_owner_read" ON store_products;
CREATE POLICY "store_products_owner_read" ON store_products
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM businesses b
       WHERE b.id = store_products.business_id AND b.user_id = auth.uid()
    )
  );

COMMENT ON TABLE store_products IS
  'Ingested product catalog per business (Shopify public products.json or future sources). Synced by services/shopify (migration 096).';

-- Store connection state on the business row itself.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS store_url TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS store_meta JSONB;

COMMENT ON COLUMN businesses.store_url IS
  'Normalized (https, host-only) customer store URL connected via POST /api/store/connect (migration 096).';
COMMENT ON COLUMN businesses.store_meta IS
  'Store connection metadata: { platform: shopify|generic, product_count, connected_at, top_product_ids } (migration 096).';
