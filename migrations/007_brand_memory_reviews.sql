-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 007: Brand Memory + Reviews
-- Run AFTER migrations 001–006.
-- Safe to re-run: all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Reviews: review_requests ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_email TEXT NOT NULL,
  contact_name  TEXT,
  platform      TEXT DEFAULT 'google',
  sent_at       TIMESTAMPTZ DEFAULT NOW(),
  opened        BOOLEAN DEFAULT FALSE,
  clicked       BOOLEAN DEFAULT FALSE,
  review_link   TEXT
);

-- ── Reviews: reviews ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform           TEXT NOT NULL,
  reviewer_name      TEXT,
  rating             INT CHECK (rating BETWEEN 1 AND 5),
  review_text        TEXT,
  review_date        TIMESTAMPTZ,
  platform_review_id TEXT UNIQUE,
  response_draft     TEXT,
  response_published TEXT,
  response_status    TEXT DEFAULT 'pending'
                       CHECK (response_status IN ('pending','draft_ready','published')),
  sentiment          TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_review_requests_business ON review_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_reviews_business ON reviews(business_id, platform, response_status);

-- ── businesses: google_review_link ───────────────────────────────────────────
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS google_review_link TEXT;

-- ── organizations: support email for white label ──────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS white_label_support_email TEXT;

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('review_requests','reviews')
ORDER BY tablename;
