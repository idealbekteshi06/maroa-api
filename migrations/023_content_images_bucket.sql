-- Public bucket for Higgsfield-generated images mirrored to permanent Supabase URLs.
-- Alternatively create in Dashboard: Storage → New bucket → name content-images → Public: true.
INSERT INTO storage.buckets (id, name, public)
VALUES ('content-images', 'content-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;
