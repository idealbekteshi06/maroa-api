-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 006: CRM + Competitor Intelligence + Content Engine
-- Run AFTER migrations 001–005.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── CRM: contacts ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  phone            TEXT,
  company          TEXT,
  source           TEXT DEFAULT 'manual',
  lead_score       INT DEFAULT 0,
  stage            TEXT DEFAULT 'lead'
                     CHECK (stage IN ('lead','qualified','opportunity','customer','churned')),
  tags             TEXT[] DEFAULT '{}',
  custom_fields    JSONB DEFAULT '{}',
  sms_opted_in     BOOLEAN DEFAULT FALSE,
  last_activity_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, email)
);

-- ── CRM: contact_activities ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_activities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CRM: deals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  value              NUMERIC DEFAULT 0,
  stage              TEXT DEFAULT 'new'
                       CHECK (stage IN ('new','contacted','proposal','negotiation','won','lost')),
  probability        INT DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  expected_close_date DATE,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── Competitor Intelligence: competitor_snapshots ─────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  competitor_name  TEXT NOT NULL,
  competitor_url   TEXT,
  snapshot_date    DATE NOT NULL,
  social_posts     JSONB DEFAULT '[]',
  active_ads       JSONB DEFAULT '[]',
  keyword_rankings JSONB DEFAULT '[]',
  content_themes   TEXT[],
  pricing_data     JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Competitor Intelligence: competitor_reports ───────────────────────────────
CREATE TABLE IF NOT EXISTS competitor_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_date      DATE NOT NULL,
  new_offers       JSONB DEFAULT '[]',
  content_themes   JSONB DEFAULT '[]',
  ad_angles        JSONB DEFAULT '[]',
  pricing_changes  JSONB DEFAULT '[]',
  recommendation   TEXT,
  raw_analysis     JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Content Engine: content_pieces ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_pieces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type                TEXT NOT NULL
                        CHECK (type IN ('blog','landing_page','video_script','email_template')),
  title               TEXT,
  target_keyword      TEXT,
  body                TEXT,
  meta_description    TEXT,
  featured_image_url  TEXT,
  status              TEXT DEFAULT 'draft'
                        CHECK (status IN ('draft','ready_for_review','approved','published')),
  published_url       TEXT,
  word_count          INT DEFAULT 0,
  seo_score           INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contacts_business          ON contacts(business_id, stage);
CREATE INDEX IF NOT EXISTS idx_contacts_score             ON contacts(business_id, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_contact_activities_contact ON contact_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_business             ON deals(business_id, stage);
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_biz   ON competitor_snapshots(business_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_content_pieces_business    ON content_pieces(business_id, type, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'contacts','contact_activities','deals',
    'competitor_snapshots','competitor_reports','content_pieces'
  )
ORDER BY tablename;
