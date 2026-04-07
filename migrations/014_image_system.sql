-- Migration 014: Premium Image Generation System
-- Tables for branded variants, user layout preferences, generated images

CREATE TABLE IF NOT EXISTS image_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform TEXT NOT NULL,
  preferred_layout TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, platform)
);

CREATE TABLE IF NOT EXISTS generated_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  content_id UUID,
  platform TEXT,
  variant_index INTEGER,
  layout_name TEXT,
  background_url TEXT,
  final_url TEXT,
  video_url TEXT,
  was_selected BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_images_user ON generated_images(user_id);
CREATE INDEX IF NOT EXISTS idx_image_prefs_user ON image_preferences(user_id);

ALTER TABLE image_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_images ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "service_full_images" ON generated_images FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_full_prefs" ON image_preferences FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
