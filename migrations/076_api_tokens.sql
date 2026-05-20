-- migrations/076_api_tokens.sql
-- ----------------------------------------------------------------------------
-- User-issuable API tokens. Used by:
--   - CLI (npx maroa setup)
--   - Browser extension (right-click → Save to Maroa)
--   - MCP server (Bearer token for action tools)
--   - Custom integrations (Zapier-style)
--
-- Stored model:
--   - Each token has a public `prefix` (first 8 chars, shown in the list UI
--     so the user can identify which token is which) and a `secret_hash`
--     (bcrypt of the full token). The full plaintext secret is returned
--     ONCE at creation time and never stored.
--
--   - Tokens scope to a single Maroa user. Authorization on requests still
--     goes through requireAnyUserId — the token verifier looks up the
--     user_id, hands it to the existing middleware, and the rest of the
--     stack is unchanged.
--
--   - 90-day default expiry. Revocable any time (`revoked_at` not null →
--     all subsequent uses reject with 401 + code TOKEN_REVOKED).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_tokens (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL,
  label        text NOT NULL,
  prefix       text NOT NULL,
  secret_hash  text NOT NULL,
  scopes       text[] NOT NULL DEFAULT ARRAY['read', 'write'],
  last_used_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user
  ON api_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_tokens_prefix
  ON api_tokens (prefix);

CREATE INDEX IF NOT EXISTS idx_api_tokens_active
  ON api_tokens (user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE api_tokens DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_tokens IS
  'User-issuable API tokens for CLI / extension / MCP / integrations. Secret stored as bcrypt hash; full token returned once at create.';
