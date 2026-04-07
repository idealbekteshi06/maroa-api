-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Paid Ads Module — extend ad_campaigns + add ad_creatives
-- Run AFTER migrations 001–004.
-- Safe to re-run: all statements use IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Extend ad_campaigns ───────────────────────────────────────────────────────
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS platform         TEXT DEFAULT 'meta';
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS google_campaign_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS google_ad_group_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS objective         TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS impressions       INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS clicks            INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS conversions       INT DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS total_spend       NUMERIC DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS roas              NUMERIC DEFAULT 0;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS ai_strategy       JSONB;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS creatives         JSONB DEFAULT '[]';
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS paused_reason     TEXT;

-- ── ad_creatives table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_creatives (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id      UUID REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL,
  headline         TEXT,
  primary_text     TEXT,
  description      TEXT,
  cta              TEXT,
  image_url        TEXT,
  image_prompt     TEXT,
  meta_creative_id TEXT,
  status           TEXT DEFAULT 'active',
  impressions      INT DEFAULT 0,
  clicks           INT DEFAULT 0,
  ctr              NUMERIC DEFAULT 0,
  is_winner        BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_creatives_campaign ON ad_creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_platform ON ad_campaigns(business_id, platform, status);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'ad_campaigns'
  AND column_name IN (
    'platform','google_campaign_id','google_ad_group_id','objective',
    'impressions','clicks','conversions','total_spend','roas','ai_strategy','creatives','paused_reason'
  )
ORDER BY column_name;
