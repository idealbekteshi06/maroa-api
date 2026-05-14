-- migrations/066_workspaces_multi_tenant.sql
-- ───────────────────────────────────────────────────────────────────────
-- The multi-tenant layer — unlocks Freelancer Mode + Agency Mode.
-- ADR-0011.
--
-- WHY THIS EXISTS
-- ════════════════
-- The system currently models one business = one customer (a solo SMB).
-- The strategy shift (2026-05-14) says the real buyers are FREELANCERS
-- (5–20 clients) and AGENCIES (multi-team, white-label, approvals). Both
-- need a layer between user + business: a workspace.
--
-- ENTITY MODEL
-- ════════════
--   user                        — Supabase auth.users
--    └── owns ──> workspace      — "Acme Marketing" (one freelancer's office, or one agency)
--                  ├── members ──> users (role: owner/strategist/designer/client/viewer)
--                  └── manages ──> client_relationships ──> businesses (existing table)
--
-- A solo SMB still works unchanged — their `business` has no workspace.
-- A freelancer creates a workspace + adds 10 client businesses to it.
-- An agency creates one workspace + adds team members + adds 50 clients.
--
-- TABLES
-- ══════
--   workspaces             — top-level container; pricing tier lives here
--   workspace_members      — who has access + role
--   workspace_invites      — pending invites with magic-link tokens
--   client_relationships   — many businesses managed by one workspace
--   client_approvals       — per-decision approval workflow
--
-- RLS
-- ═══
-- Each table: members (with any role) can SELECT; only service_role can
-- INSERT/UPDATE/DELETE. The /api auth middleware verifies role tier in
-- the application layer for state changes.
--
-- BACKWARDS COMPAT
-- ════════════════
-- Marketing Graph tables (065) and existing business-scoped tables stay
-- workspace-unaware. A NULL workspace_id (where applicable) means
-- "solo customer, no workspace." The application layer attributes the
-- right scope at query time.
--
-- ROLLBACK
-- ════════
-- DROP TABLE in reverse order. Workspaces never become hard FK targets
-- of pre-066 tables, so no cascading damage on rollback.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. workspaces
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL,                                       -- Supabase auth.users.id
  name            text NOT NULL,
  slug            text UNIQUE,                                         -- URL-safe handle
  plan_tier       text NOT NULL DEFAULT 'freelancer'
                  CHECK (plan_tier IN ('solo','freelancer','agency','enterprise')),

  -- White-label settings (agency tier only — enforced at app layer)
  white_label     jsonb NOT NULL DEFAULT '{}'::jsonb,                  -- { logo_url, primary_color, custom_domain, company_name }

  -- Per-workspace settings
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,                  -- { default_approval_band, auto_publish_threshold_usd, ... }

  -- Billing
  monthly_spend_usd           numeric(10,2) NOT NULL DEFAULT 0,
  monthly_spend_cap_usd       numeric(10,2),                            -- null = no cap
  client_seat_count           integer NOT NULL DEFAULT 0,
  team_seat_count             integer NOT NULL DEFAULT 1,
  status                      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id, status);
CREATE INDEX IF NOT EXISTS workspaces_slug_idx  ON workspaces (slug) WHERE slug IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. workspace_members — role-based access
-- ═══════════════════════════════════════════════════════════════════════
-- Roles (enforced at app layer via middleware/workspaceRole.js):
--   owner       — full control, can delete workspace, change plan
--   strategist  — can create campaigns, approve content, run experiments
--   designer    — can create/edit creative assets, can't change spend
--   client      — read-only on their own client_relationships (sees only their data)
--   viewer      — read-only, no edits
CREATE TABLE IF NOT EXISTS workspace_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','strategist','designer','client','viewer')),

  -- For client role: limit visibility to specific client_relationships
  visible_client_ids  uuid[] NOT NULL DEFAULT '{}',

  invited_by    uuid,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id, workspace_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. workspace_invites — pending invites with magic-link tokens
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS workspace_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','strategist','designer','client','viewer')),
  token         text NOT NULL UNIQUE,                  -- random 32+ char URL-safe
  invited_by    uuid,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_invites_token_idx  ON workspace_invites (token);
CREATE INDEX IF NOT EXISTS workspace_invites_pending_idx ON workspace_invites (workspace_id, accepted_at) WHERE accepted_at IS NULL AND cancelled_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. client_relationships — workspaces ↔ businesses
-- ═══════════════════════════════════════════════════════════════════════
-- One workspace can manage many businesses (clients). One business is
-- typically managed by one workspace (UNIQUE), but we allow business-id
-- portability in case a client switches agencies.
CREATE TABLE IF NOT EXISTS client_relationships (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  business_id         uuid NOT NULL,                       -- FK to businesses
  client_name         text,                                -- display label (may differ from business_name)
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','offboarded')),
  monthly_retainer_usd numeric(10,2),
  notes               text,
  attrs               jsonb NOT NULL DEFAULT '{}'::jsonb,

  added_at            timestamptz NOT NULL DEFAULT now(),
  offboarded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, business_id)
);

CREATE INDEX IF NOT EXISTS client_rel_workspace_idx ON client_relationships (workspace_id, status, added_at DESC);
CREATE INDEX IF NOT EXISTS client_rel_business_idx  ON client_relationships (business_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. client_approvals — per-decision approval workflow
-- ═══════════════════════════════════════════════════════════════════════
-- The freelancer-mode killer: every decision flagged as needing approval
-- gets a magic-link URL the client can use to approve/reject without
-- needing a Maroa account.
CREATE TABLE IF NOT EXISTS client_approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  business_id         uuid NOT NULL,
  decision_log_id     uuid REFERENCES decision_logs (id) ON DELETE SET NULL,

  approval_token      text NOT NULL UNIQUE,             -- 32+ char URL-safe
  preview_url         text,                             -- optional UI to show what's being approved
  preview_data        jsonb NOT NULL DEFAULT '{}'::jsonb,

  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','expired','cancelled')),

  client_email        text,
  approved_by_email   text,
  approved_at         timestamptz,
  rejected_reason     text,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_approvals_token_idx ON client_approvals (approval_token);
CREATE INDEX IF NOT EXISTS client_approvals_pending_idx ON client_approvals (workspace_id, status, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS client_approvals_decision_idx ON client_approvals (decision_log_id) WHERE decision_log_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- Row-level security
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE workspaces            ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invites     ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_relationships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_approvals      ENABLE ROW LEVEL SECURITY;

-- Helper: is the current user a member of the given workspace?
CREATE OR REPLACE FUNCTION _is_workspace_member(_ws_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = _ws_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql STABLE;

-- workspaces: owner OR member can read.
DROP POLICY IF EXISTS workspaces_member_read ON workspaces;
CREATE POLICY workspaces_member_read ON workspaces FOR SELECT USING (
  owner_user_id = auth.uid() OR _is_workspace_member(id)
);

DROP POLICY IF EXISTS workspaces_service_write ON workspaces;
CREATE POLICY workspaces_service_write ON workspaces FOR ALL TO service_role USING (true) WITH CHECK (true);

-- workspace_members: members of the workspace can see the roster.
DROP POLICY IF EXISTS workspace_members_self_read ON workspace_members;
CREATE POLICY workspace_members_self_read ON workspace_members FOR SELECT USING (
  user_id = auth.uid() OR _is_workspace_member(workspace_id)
);

DROP POLICY IF EXISTS workspace_members_service_write ON workspace_members;
CREATE POLICY workspace_members_service_write ON workspace_members FOR ALL TO service_role USING (true) WITH CHECK (true);

-- workspace_invites: only workspace members can list pending invites.
DROP POLICY IF EXISTS workspace_invites_member_read ON workspace_invites;
CREATE POLICY workspace_invites_member_read ON workspace_invites FOR SELECT USING (_is_workspace_member(workspace_id));

DROP POLICY IF EXISTS workspace_invites_service_write ON workspace_invites;
CREATE POLICY workspace_invites_service_write ON workspace_invites FOR ALL TO service_role USING (true) WITH CHECK (true);

-- client_relationships: workspace members see all clients; client-role
-- users see only their own client_relationships (filtered by app layer
-- via visible_client_ids).
DROP POLICY IF EXISTS client_rel_member_read ON client_relationships;
CREATE POLICY client_rel_member_read ON client_relationships FOR SELECT USING (_is_workspace_member(workspace_id));

DROP POLICY IF EXISTS client_rel_service_write ON client_relationships;
CREATE POLICY client_rel_service_write ON client_relationships FOR ALL TO service_role USING (true) WITH CHECK (true);

-- client_approvals: workspace members see all approval requests.
DROP POLICY IF EXISTS client_approvals_member_read ON client_approvals;
CREATE POLICY client_approvals_member_read ON client_approvals FOR SELECT USING (_is_workspace_member(workspace_id));

DROP POLICY IF EXISTS client_approvals_service_write ON client_approvals;
CREATE POLICY client_approvals_service_write ON client_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════
-- updated_at triggers
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _workspaces_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['workspaces','client_relationships']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch_updated_at BEFORE UPDATE ON %I '
      ||'FOR EACH ROW EXECUTE FUNCTION _workspaces_touch_updated_at()',
      t, t
    );
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Comments
-- ═══════════════════════════════════════════════════════════════════════
COMMENT ON TABLE workspaces IS
  'Top-level multi-tenant container — a freelancer''s office, an agency, or an enterprise team. ADR-0011.';
COMMENT ON TABLE workspace_members IS
  'Role-based access to a workspace (owner/strategist/designer/client/viewer).';
COMMENT ON TABLE workspace_invites IS
  'Pending invites with magic-link tokens. Expire after a configurable window.';
COMMENT ON TABLE client_relationships IS
  'Many-to-many between workspaces and businesses. A freelancer''s workspace manages many client businesses.';
COMMENT ON TABLE client_approvals IS
  'Per-decision approval workflow. Magic-link tokens let clients approve without a Maroa account.';

COMMIT;
