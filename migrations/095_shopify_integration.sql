-- migrations/095_shopify_integration.sql
-- ───────────────────────────────────────────────────────────────────────
-- Shopify public-app integration.
--
-- Adds:
--   1. Per-store OAuth columns on `businesses` (one Shopify store per business,
--      mirroring how LinkedIn/X/TikTok/Meta tokens live on `businesses`). The
--      offline access token is stored ENCRYPTED ONLY (shopify_access_token_enc,
--      AES-256-GCM via lib/oauthCrypto) — there is no legacy plaintext twin
--      because this is a brand-new integration with no rows to back-compat.
--   2. Synced storefront data tables (shopify_products, shopify_orders,
--      shopify_checkouts), each tenant-scoped by business_id with the SAME
--      RLS policy shape as migration 091 (service_all + owner_read).
--
-- Tenancy: the app queries Supabase with the service-role key, which BYPASSES
-- RLS, so every app query is also manually scoped by business_id (see
-- services/shopify/store.js). The RLS policies below are defense-in-depth for
-- any path that ever uses the anon/authenticated key.
--
-- Offline tokens DO NOT expire and have no refresh token, so there is no
-- expiry column and no token-refresh cron (unlike LinkedIn/X/TikTok). The
-- token is revoked by the merchant uninstalling the app (app/uninstalled →
-- shopify_uninstalled_at set, token nulled, synced rows purged).
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS shopify_checkouts, shopify_orders, shopify_products;
--   ALTER TABLE businesses
--     DROP COLUMN IF EXISTS shopify_shop_domain,
--     DROP COLUMN IF EXISTS shopify_access_token_enc,
--     DROP COLUMN IF EXISTS shopify_scopes,
--     DROP COLUMN IF EXISTS shopify_connected,
--     DROP COLUMN IF EXISTS shopify_connected_at,
--     DROP COLUMN IF EXISTS shopify_uninstalled_at;
-- ───────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Per-store OAuth columns on businesses ────────────────────────────
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS shopify_shop_domain text,
  ADD COLUMN IF NOT EXISTS shopify_access_token_enc text,
  ADD COLUMN IF NOT EXISTS shopify_scopes text,
  ADD COLUMN IF NOT EXISTS shopify_connected boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS shopify_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS shopify_uninstalled_at timestamptz;

-- A Shopify store maps to exactly one business. The webhook ingress path
-- resolves business_id from the X-Shopify-Shop-Domain header, so this lookup
-- must be unique + indexed. Partial index keeps NULLs (unconnected businesses)
-- out of the uniqueness constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_shopify_shop_domain
  ON public.businesses (shopify_shop_domain)
  WHERE shopify_shop_domain IS NOT NULL;

-- ─── 2. Synced products ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shopify_products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  shopify_product_id text NOT NULL,
  title              text,
  handle             text,
  status             text,
  product_type       text,
  vendor             text,
  tags               text,
  price              numeric(12, 2),
  image_url          text,
  shopify_updated_at timestamptz,
  raw_data           jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (business_id, shopify_product_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_products_biz ON public.shopify_products (business_id, synced_at DESC);

-- ─── 3. Synced orders ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shopify_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  shopify_order_id   text NOT NULL,
  order_number       text,
  customer_email     text,
  customer_name      text,
  financial_status   text,
  fulfillment_status text,
  total_price        numeric(12, 2),
  currency           text,
  line_items_count   integer,
  shopify_created_at timestamptz,
  raw_data           jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (business_id, shopify_order_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_biz ON public.shopify_orders (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer
  ON public.shopify_orders (business_id, customer_email);

-- ─── 4. Synced checkouts (abandoned-cart) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shopify_checkouts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  shopify_checkout_id    text NOT NULL,
  checkout_token         text,
  customer_email         text,
  total_price            numeric(12, 2),
  currency               text,
  abandoned_checkout_url text,
  completed_at           timestamptz,
  shopify_created_at     timestamptz,
  raw_data               jsonb,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  UNIQUE (business_id, shopify_checkout_id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_biz ON public.shopify_checkouts (business_id, created_at DESC);

-- ─── 5. RLS — identical shape to migration 091 ───────────────────────────
-- Re-declare the same harden helper 091 used (091 dropped it at the end, so it
-- is not persisted). service_all (FOR ALL TO service_role) keeps server jobs
-- working; owner_read (FOR SELECT TO authenticated) scopes dashboard reads to
-- businesses the JWT user owns.
CREATE OR REPLACE FUNCTION _maroa_harden_rls(p_table text, p_owner_col text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  pol record;
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 'skip % (table not present)', p_table;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  -- Drop every existing policy; we recreate a clean, minimal set below.
  FOR pol IN
    SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = p_table
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, p_table);
  END LOOP;

  -- Server jobs use the service-role key — keep full access.
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
    p_table || '_service_all', p_table
  );

  -- Authenticated dashboard users: read only rows they own.
  IF p_owner_col = 'business_id' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ' ||
      '(EXISTS (SELECT 1 FROM businesses b WHERE b.id = %I.business_id AND b.user_id = auth.uid()))',
      p_table || '_owner_read', p_table, p_table
    );
  ELSIF p_owner_col = 'user_id' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%I.user_id = auth.uid())',
      p_table || '_owner_read', p_table, p_table
    );
  END IF;
END;
$fn$;

SELECT _maroa_harden_rls('shopify_products', 'business_id');
SELECT _maroa_harden_rls('shopify_orders', 'business_id');
SELECT _maroa_harden_rls('shopify_checkouts', 'business_id');

DROP FUNCTION _maroa_harden_rls(text, text);

COMMENT ON TABLE public.shopify_products IS 'Shopify products synced per business (migration 095). RLS: service_all + owner_read.';
COMMENT ON TABLE public.shopify_orders IS 'Shopify orders synced per business (migration 095). RLS: service_all + owner_read.';
COMMENT ON TABLE public.shopify_checkouts IS 'Shopify abandoned/started checkouts synced per business (migration 095). RLS: service_all + owner_read.';
COMMENT ON COLUMN public.businesses.shopify_access_token_enc IS 'AES-256-GCM offline access token (lib/oauthCrypto). Non-expiring; nulled on app/uninstalled.';

COMMIT;
