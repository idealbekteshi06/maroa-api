-- Migration 028: Workflow #4 — Reviews & Reputation
-- ============================================================================

-- Unified reviews table (supersedes legacy reviews table with richer schema)
-- We reuse the existing `reviews` table if present and just add columns.
ALTER TABLE IF EXISTS reviews
  ADD COLUMN IF NOT EXISTS reviewer_profile_url TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS category TEXT,           -- positive | neutral | negative | critical
  ADD COLUMN IF NOT EXISTS urgency TEXT,            -- immediate | high | medium | low
  ADD COLUMN IF NOT EXISTS topics JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS authenticity_score NUMERIC(5,2) DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_suspicious BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS legal_flags JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS response_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_account_age_days INT,
  ADD COLUMN IF NOT EXISTS reviewer_review_count INT,
  ADD COLUMN IF NOT EXISTS reviewer_location TEXT,
  ADD COLUMN IF NOT EXISTS transaction_verified BOOLEAN;

-- Create reviews table if it doesn't already exist (legacy repos may not have it)
CREATE TABLE IF NOT EXISTS reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  platform     TEXT NOT NULL,
  reviewer_name TEXT,
  rating       NUMERIC(3,1),
  body         TEXT,
  sentiment    NUMERIC(4,3),
  posted_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_biz_category ON reviews (business_id, category);
CREATE INDEX IF NOT EXISTS idx_reviews_biz_status ON reviews (business_id, response_status);
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reviews_service_full" ON reviews;
CREATE POLICY "reviews_service_full" ON reviews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_responses: AI-generated draft responses
CREATE TABLE IF NOT EXISTS review_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  signature_name TEXT,
  signature_title TEXT,
  personalization_score NUMERIC(5,2),
  brand_voice_match_score NUMERIC(5,2),
  word_count   INT,
  psychology_levers JSONB DEFAULT '[]',
  predicted_impact TEXT,
  is_active    BOOLEAN DEFAULT true,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_responses_review ON review_responses (review_id);
ALTER TABLE review_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_resp_service_full" ON review_responses;
CREATE POLICY "review_resp_service_full" ON review_responses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_requests: outbound "please leave a review" asks
CREATE TABLE IF NOT EXISTS review_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  customer_id  UUID,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  channel      TEXT,       -- email | sms | whatsapp
  platform     TEXT,       -- which review platform they should leave it on
  trigger_kind TEXT,
  product_or_service TEXT,
  staff_member TEXT,
  sent_at      TIMESTAMPTZ,
  status       TEXT DEFAULT 'queued',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_req_service_full" ON review_requests;
CREATE POLICY "review_req_service_full" ON review_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

-- review_disputes: when a review is submitted for platform removal
CREATE TABLE IF NOT EXISTS review_disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reason       TEXT,
  justification TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform_response TEXT,
  outcome      TEXT         -- pending | accepted | rejected
);
ALTER TABLE review_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "review_disp_service_full" ON review_disputes;
CREATE POLICY "review_disp_service_full" ON review_disputes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- testimonial_library: high-signal quotes we can reuse in marketing
CREATE TABLE IF NOT EXISTS testimonial_library (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL,
  review_id    UUID REFERENCES reviews(id) ON DELETE SET NULL,
  platform     TEXT,
  reviewer_name TEXT,
  rating       NUMERIC(3,1),
  quote        TEXT,
  permission_status TEXT DEFAULT 'not_requested', -- not_requested | requested | granted | declined
  used_in      JSONB DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE testimonial_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "testimonials_service_full" ON testimonial_library;
CREATE POLICY "testimonials_service_full" ON testimonial_library FOR ALL TO service_role USING (true) WITH CHECK (true);
