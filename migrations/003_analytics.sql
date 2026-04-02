-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003: Unified Analytics tables
-- Run AFTER migrations 001 + 002.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  snapshot_date    DATE NOT NULL,
  platform         TEXT NOT NULL,
  impressions      INT DEFAULT 0,
  reach            INT DEFAULT 0,
  engagement       INT DEFAULT 0,
  clicks           INT DEFAULT 0,
  followers_gained INT DEFAULT 0,
  posts_published  INT DEFAULT 0,
  email_sent       INT DEFAULT 0,
  email_opens      INT DEFAULT 0,
  email_clicks     INT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, snapshot_date, platform)
);

CREATE TABLE IF NOT EXISTS analytics_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start       DATE NOT NULL,
  headline         TEXT,
  wins             JSONB DEFAULT '[]',
  concerns         JSONB DEFAULT '[]',
  recommendations  JSONB DEFAULT '[]',
  overall_score    INT CHECK (overall_score BETWEEN 1 AND 10),
  raw_data         JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_business ON analytics_snapshots(business_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_business   ON analytics_reports(business_id);

-- Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('analytics_snapshots','analytics_reports')
ORDER BY tablename;
