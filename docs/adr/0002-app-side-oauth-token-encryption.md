# ADR-0002: Encrypt OAuth tokens at rest via app-side AES-256-GCM (not pgcrypto)

**Date:** 2026-05 · **Status:** Accepted

## Context

Migration 052 added per-customer OAuth columns to `businesses`:
`google_refresh_token`, `meta_access_token`, `facebook_page_access_token`,
`tiktok_access_token`. They were stored as plain `text` columns.

A pen-test thought experiment: if the Supabase service-role key leaks
(or Supabase has a breach), the attacker gets long-lived authenticated
access to every customer's Meta Ads, Google Ads, and TikTok accounts.
The blast radius is identity-theft-level — they can publish ads, drain
budgets, or post on behalf of every customer.

## Decision

Encrypt these tokens at rest using **AES-256-GCM applied app-side**
(via Node's `crypto.createCipheriv`), with the key kept in
`OAUTH_TOKEN_ENC_KEY` env var (Doppler / Railway env, never the DB).

The encrypted ciphertext is stored as a text blob in the format
`v1:<iv_hex>:<tag_hex>:<ct_hex>` in new `*_enc` columns (migration 056).
The legacy plaintext columns are kept during a transition period; a
follow-up migration (060) drops them once backfill is verified.

## Alternatives considered

| Option | Why we didn't pick it |
|---|---|
| `pgp_sym_encrypt` (pgcrypto) | Requires the symmetric key inside SQL function calls or `current_setting()`. Supabase doesn't let us set custom GUCs from outside, and embedding the key as a literal in PATCH bodies puts it on the wire in cleartext from the app to Supabase. App-side encryption keeps the key in the app container only. |
| AWS KMS / Google Cloud KMS | Adds a third-party vendor + IAM setup + per-decryption cost. AES-256-GCM with a single rotated key is the same security property for a single-region SaaS. |
| HashiCorp Vault | More moving parts than we need at our scale; Doppler covers our secret-rotation use case. |
| Don't encrypt — rely on Supabase RLS | RLS doesn't help against service-role-key compromise, which is the threat we're modeling. |

## Consequences

**Positive:**
- Trust boundary moves from "Supabase doesn't leak" to
  "the encryption key doesn't leak." The key lives in one place
  (Doppler/Railway env), not 50K rows in a database.
- AES-256-GCM is authenticated encryption — tampering is detected.
- The scheme works for any Postgres-on-anything, not just Supabase.
- Zero new runtime deps (uses node:crypto).

**Negative:**
- App must hold the key. Lose it → lose decryptability of every token.
  Mitigation: documented in PUNCHLIST that the operator must save the
  generated key in 1Password the first time it's set.
- Reads always go through `lib/oauthCrypto.readToken()`. Forgetting this
  in a new consumer means it reads `null` (legacy column will be
  dropped post-migration-060). Mitigation: lint rule planned to flag
  direct reads of `*_access_token` columns.
- Key rotation requires a re-encrypt migration (read-decrypt-with-old,
  re-encrypt-with-new). Not painful, but procedural.

## Operational notes

- Generate key: `openssl rand -hex 32`. 32-byte / 256-bit / 64 hex chars.
- Configure: `OAUTH_TOKEN_ENC_KEY=<hex>` in Railway env + Doppler.
- Backfill existing rows: `npm run encrypt-oauth-tokens` (one-time).
- Decrypt at read sites: `oauthCrypto.readToken(row, 'meta_access_token')`
  — prefers `*_enc`, falls back to legacy `*` column during transition.
- Future scheme upgrade: bump `SCHEME` constant in `lib/oauthCrypto.js`
  and write `v1 → v2` migration. The version prefix in every blob lets
  us mix old + new during the transition.
