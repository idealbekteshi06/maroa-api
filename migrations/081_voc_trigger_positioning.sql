-- Migration 081 — persist customer-research fields on voc_analyses
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS trigger_events JSONB DEFAULT '[]';
ALTER TABLE voc_analyses ADD COLUMN IF NOT EXISTS positioning_implications JSONB DEFAULT '[]';
