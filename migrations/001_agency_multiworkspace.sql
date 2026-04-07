-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001: Agency Multi-Workspace tables
-- Run in: Supabase Dashboard → SQL Editor → New Query → paste → Run
-- Safe to re-run: all statements use IF NOT EXISTS guards
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. organizations
CREATE TABLE IF NOT EXISTS organizations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  owner_user_id             UUID,
  plan                      TEXT DEFAULT 'agency',
  stripe_customer_id        TEXT,
  white_label_logo_url      TEXT,
  white_label_primary_color TEXT DEFAULT '#667eea',
  white_label_company_name  TEXT,
  white_label_domain        TEXT,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- 2. organization_members
CREATE TABLE IF NOT EXISTS organization_members (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL,
  role             TEXT DEFAULT 'member' CHECK (role IN ('owner','admin','member','client')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);

-- 3. workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id      UUID REFERENCES businesses(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  client_name      TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Scope businesses to orgs
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS workspace_id    UUID REFERENCES workspaces(id);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_org   ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_businesses_org   ON businesses(organization_id);

-- 6. Row Level Security
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_owners_all"       ON organizations;
DROP POLICY IF EXISTS "org_members_read"     ON organizations;
DROP POLICY IF EXISTS "members_see_own_org"  ON organization_members;
DROP POLICY IF EXISTS "workspace_org_scope"  ON workspaces;

CREATE POLICY "org_owners_all" ON organizations
  FOR ALL USING (owner_user_id = auth.uid());

CREATE POLICY "org_members_read" ON organizations
  FOR SELECT USING (
    id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY "members_see_own_org" ON organization_members
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

CREATE POLICY "workspace_org_scope" ON workspaces
  FOR SELECT USING (
    organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid())
  );

-- 7. Verify
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('organizations','organization_members','workspaces')
ORDER BY tablename;
