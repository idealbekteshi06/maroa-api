-- Migration 082 — WF10 studio job model metadata (Higgsfield 2026)
-- Persists smart-router + camera preset + credit estimates on studio_jobs.

ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS model_used TEXT;
ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS camera_preset TEXT;
ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS credits_used INTEGER;
ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS model_version TEXT;

CREATE INDEX IF NOT EXISTS idx_studio_jobs_model_used ON studio_jobs(model_used);
