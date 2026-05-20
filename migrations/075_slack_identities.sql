-- migrations/075_slack_identities.sql
-- ----------------------------------------------------------------------------
-- Slack ↔ Maroa user identity mapping. One Slack user → one Maroa user.
-- Filled by the /maroa link magic-link flow; routes/slack.js looks rows up
-- before running any command that mutates Maroa state.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS slack_identities (
  id              bigserial PRIMARY KEY,
  slack_user_id   text NOT NULL UNIQUE,
  slack_team_id   text,
  maroa_user_id   uuid NOT NULL,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_slack_identities_maroa_user
  ON slack_identities (maroa_user_id);

CREATE INDEX IF NOT EXISTS idx_slack_identities_active
  ON slack_identities (slack_user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE slack_identities DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_identities IS
  'Slack ↔ Maroa user mapping. Filled by /maroa link magic-link flow. routes/slack.js verifies every command against this table.';
