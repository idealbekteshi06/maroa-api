# Phase-1 Punch List — what's left for you

This branch (`claude/level-up-phase-1`) ships 9 waves of code. The items
below are things only **you** can do — they require vendor accounts,
production access, legal review, or business decisions a code change
can't make.

Items are grouped by urgency. Treat **CRITICAL** as "do this week."

---

## CRITICAL — do this week

### 1. Rotate every leaked secret

The file `setup.sh` (gitignored on this machine but still on your laptop)
contains live production keys in plaintext. Treat every one of them as
compromised. The `n8n-workflows/*.json` files in the legacy archive
embed the same Supabase service-role key in 10+ places.

Rotate in order of blast radius:

- [ ] **Anthropic** — https://console.anthropic.com/settings/keys
  Revoke `sk-ant-api03-2wwBU3RhNG…` and issue a new one. Update
  `ANTHROPIC_KEY` in Railway env.
- [ ] **Supabase service-role** — Supabase dashboard → Project Settings
  → API → "Reset service role key." Update `SUPABASE_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` in Railway env. **Every** n8n-workflows
  JSON file that embeds this key is now broken — that's intentional.
- [ ] **Replicate** — `r8_Jet7AKlTlr6…`. Revoke at https://replicate.com/account/api-tokens, mint new, update `REPLICATE_API_KEY`.
- [ ] **SerpAPI** — revoke + remint. Update `SERPAPI_KEY`.
- [ ] **Pexels** — revoke + remint. Update `PEXELS_API_KEY`.
- [ ] **Meta app secret** — `21a29db7504ebfa9740d247c8c8fd056`. Meta
  Developer console → App Dashboard → Settings → Basic → Reset App
  Secret. Update `META_APP_SECRET`.
- [ ] **n8n Cloud JWT** — kill the n8n Cloud account entirely if you're
  fully off n8n (which we are; nothing imports those workflows now).
- [ ] **`setup.sh`** — delete from local disk and from any backups
  (`cd ~/Desktop/Maroa.ai && shred setup.sh && rm setup.sh`).

After rotating, run `git log -p --all -- 'setup.sh' 'n8n-workflows/*.json'`
to confirm no version of the file currently in HEAD contains a live key.

### 2. Configure secrets in Doppler / Railway env (not `.env` files)

- [ ] Sign up for Doppler (or use Railway env vars exclusively in prod).
  Move every value previously in `setup.sh` into Doppler.
- [ ] Generate `OAUTH_TOKEN_ENC_KEY` for at-rest OAuth token encryption:
  ```
  openssl rand -hex 32
  ```
  Add to Railway env AND Doppler. **Save the value** — losing it means
  losing decryptability of every OAuth token.
- [ ] Set `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE=0.1`, `RELEASE=<git-sha>`
  on Railway.

### 3. Apply the new migrations to Supabase

In Supabase SQL editor, run in order:

- [ ] `migrations/054_webhook_events.sql` — webhook idempotency table.
  Once applied, the dedup behavior in `lib/webhookEvents.js` activates
  (until then it soft-fails and processes duplicates).
- [ ] `migrations/055_migrations_ledger.sql` — `_migrations` table.
  Once applied, run `INSERT INTO _migrations (filename, checksum)
  SELECT filename, '<sha256>' FROM ...` for every prior migration that's
  already applied. `npm run check-migrations:applied` will tell you
  which are missing.
- [ ] `migrations/056_oauth_token_encryption.sql` — adds `*_enc` columns
  for OAuth tokens. New tokens auto-encrypt; existing ones stay
  plaintext until you run the backfill.

### 4. Run the OAuth token backfill

After migration 056 is applied AND `OAUTH_TOKEN_ENC_KEY` is set:

```bash
# Dry-run first to count rows
OAUTH_TOKEN_ENC_KEY=<your-key> \
SUPABASE_URL=<...> SUPABASE_KEY=<...> \
node scripts/encrypt-oauth-tokens.js --dry-run

# Real run
OAUTH_TOKEN_ENC_KEY=<your-key> \
SUPABASE_URL=<...> SUPABASE_KEY=<...> \
node scripts/encrypt-oauth-tokens.js
```

Verify success: pick one business, fetch its `google_refresh_token_enc`
or `meta_access_token_enc` column, decrypt with `lib/oauthCrypto.decrypt()`
and confirm it matches the legacy plaintext column.

### 5. Configure GitHub Actions secrets

The new `.github/workflows/ci.yml` runs lint + test + audit + secret-scan
on every PR. It uses `GITHUB_TOKEN` (auto-provided) but you may want to
add:

- [ ] `SUPABASE_URL` + `SUPABASE_KEY` as **repository secrets** if you
  want `--verify-applied` to run in CI.
- [ ] Enable "Require status checks to pass before merging" on the `main`
  branch (Settings → Branches → Branch protection rules).

---

## HIGH — do this month

### 6. Drop the legacy plaintext OAuth columns (migration 060)

After ~2 weeks of running with encrypted writes + the backfill applied,
verify every row has a populated `*_enc` column, then write and apply:

```sql
-- migrations/060_drop_plaintext_oauth_tokens.sql
ALTER TABLE businesses DROP COLUMN google_refresh_token;
ALTER TABLE businesses DROP COLUMN meta_access_token;
ALTER TABLE businesses DROP COLUMN facebook_page_access_token;
ALTER TABLE businesses DROP COLUMN instagram_access_token;
ALTER TABLE businesses DROP COLUMN tiktok_access_token;
ALTER TABLE businesses DROP COLUMN google_access_token;
```

Before applying, audit every read site. `oauthCrypto.readToken()` should
already be returning the encrypted value preferentially — so all reads
should work after the drop. Grep `meta_access_token\|google_refresh_token`
to find any remaining direct reads.

### 7. Update consuming services to use `oauthCrypto.readToken`

The OAuth save paths (`services/oauth/{meta,google}.js`) and the new
24h feedback endpoint already use `oauthCrypto.readToken`. The other
read sites still hit the plaintext columns:

- [ ] `services/google-ads-api/index.js` — uses `google_refresh_token`
- [ ] `services/meta-marketing/index.js` — uses `meta_access_token`
- [ ] Various `services/wf*/` files — search:
      `grep -rn 'meta_access_token\|google_refresh_token' services/`

For each: replace the direct column read with `oauthCrypto.readToken(row, 'col_name')`. Until done, those services will work via the legacy
column — but migration 060 will break them.

### 8. Empty-catch cleanup

The new ESLint rule `no-empty: ["warn", { allowEmptyCatch: false }]`
flags 105 existing `catch {}` blocks. Each one is silently swallowing
an error. Treat the warnings as a backlog: every PR that touches a
file with one, fix the catches in that file before merging. The rule
will go to `"error"` once the count drops below 20.

Quick scan:
```
npm run lint 2>&1 | grep -c "Empty block statement"
```

### 9. Audit npm vulnerabilities

```
npm audit --audit-level=high
```

The audit at scan time showed a moderate vuln in `express-rate-limit →
ip-address`. Decide: live with it (file in this punch-list), upgrade
the offending package, or replace `express-rate-limit` entirely with
`@upstash/ratelimit` (which is already a dep — see [README.md](./README.md)).

### 10. Status page + on-call

- [ ] Sign up for statuspage.io / instatus / Atlassian Status Page.
- [ ] Sign up for PagerDuty / OpsGenie (free tiers exist).
- [ ] Wire `/healthz` failure → PagerDuty page.
- [ ] Document on-call rota in `docs/incident-runbook.md`.

---

## MEDIUM — do this quarter

### 11. Finish the server.js carve-up

`server.js` is now ~11,800 lines after my edits (down from 11,822 by
removing the legacy raw-Opus call sites). Target: under 4,000.

`routes/observability.js` is the template. Carve in this order (ROI):

- [ ] `routes/oauth-extras.js` — the OAuth-state routes still in server.js
- [ ] `routes/onboarding.js` — `/api/onboarding/*` (around line ~10,400)
- [ ] `routes/twitter.js` — Twitter OAuth + post flows
- [ ] `routes/tiktok.js` — TikTok OAuth + post flows
- [ ] `routes/linkedin.js` — LinkedIn UGC posts
- [ ] `routes/meta-ads.js` — Meta campaign create/manage
- [ ] `routes/google-ads.js` — Google Ads
- [ ] `routes/cold-start.js` — onboarding orchestrator hooks
- [ ] `routes/admin.js` — `/api/admin/*` if any

Each file follows the `register({ app, ...deps })` pattern in
`routes/observability.js`.

### 12. Real test harnesses

- [ ] `tests/helpers/fakeAnthropic.js` — fake Claude that returns
      canned responses by skill name. Use in every prompt-module test.
- [ ] `tests/helpers/fakeInngest.js` — drives Inngest functions
      synchronously with a fake `step` object.
- [ ] `tests/helpers/fakeSupabase.js` — in-memory PostgREST fake.
- [ ] Add at least 5 end-to-end tests covering onboarding → publish.

### 13. Prompt eval harness

`services/prompts/manifest.json` already exists but is unread. Build:

- [ ] Per-prompt golden-output fixtures in `tests/fixtures/prompts/`.
- [ ] `scripts/eval-prompts.js` that runs every prompt module against
      fixtures and reports drift via embedding-similarity.
- [ ] Pin prompt versions in `manifest.json` and log the version with
      every `callClaude` invocation.

### 14. Higgsfield + Meta marketing tests

`services/higgsfield.js` (1,473 LOC) has zero unit tests. Refactor it
into `providers/cloud.js`, `providers/fnf.js`, `models/*.js`,
`lifecycle.js`, then add contract tests for each.

`services/meta-marketing/index.js` has no error-code mapping for
`X-Business-Use-Case-Usage` rate-limit headers. Add a mapping table
and surface it via Sentry tags.

---

## LOW — do this half

### 15. OpenAPI spec from zod

Use `zod-to-openapi` to generate `docs/openapi.yml` from the request
schemas already in `lib/schemas.js`. Once generated, publish at `/docs`
via Redoc or Swagger UI.

### 16. Brand-voice anchor auto-load

`services/prompts/brand-voice/index.js` exists. Wire it into `callClaude`
so every call automatically reads `business_profiles.brand_voice_anchor`
JSONB and injects it into the system prompt without each caller
remembering to do so.

### 17. Quality-gate enforcement

`services/prompts/quality-gate/index.js:gate()` exists but isn't called
consistently. Insert it into every engine's publish path:

- [ ] `services/wf1/dailyRun.js` — content engine
- [ ] `services/cro/engine.js` — rewrite paths
- [ ] `services/weekly-scorecard/engine.js` — narrative
- [ ] `services/ad-optimizer/engine.js` — `decision_reason`

### 18. Sign up for legal docs

- [ ] Publish a Data Processing Agreement (DPA). Template:
      https://www.gdprhub.eu/ or your legal counsel.
- [ ] Publish a Terms of Service.
- [ ] Publish a Subprocessor List (Anthropic, Supabase, Railway,
      Higgsfield, Paddle, Resend, Ayrshare, Twilio, etc.).
- [ ] Add `/legal/dpa`, `/legal/tos`, `/legal/subprocessors` static
      routes in the frontend repo.

---

## What this branch already covers (don't redo)

You can stop worrying about these — Phase 1 took care of them:

- ✅ Env validation at boot (`lib/env.js` + zod)
- ✅ Trust proxy 1 (rate-limits work behind Railway)
- ✅ Sentry PII scrubber + tracesSampleRate + release tag
- ✅ Timing-safe webhook secret compare
- ✅ Removed the `/api/laun ompts` typo route
- ✅ Default external HTTP timeout 120s → 15s
- ✅ PostgREST injection closed in `planGate`, `planLimits`, `costGuard`
- ✅ OAuth state binds to authenticated user_id + nonce + ts
- ✅ Paddle timestamp tolerance (5 min replay window)
- ✅ Stripe + Paddle webhook idempotency via `webhook_events` table
- ✅ Migrations 054, 055, 056 written (not yet applied — see item 3)
- ✅ AES-256-GCM OAuth token encryption (`lib/oauthCrypto.js`)
- ✅ Cost tracking wired into `callClaude` (real spend in `llm_cost_logs`)
- ✅ Cost guard mounted globally on every paid LLM endpoint
- ✅ Three raw Opus calls routed through `callClaude` (cache, retry, cost)
- ✅ Advisor pattern (`callWithAdvisor`) wired into ad-optimizer + cro
- ✅ Object-shape `callClaude` adapter — unlocks every prompt module
- ✅ 24h `setTimeout` replaced with durable Inngest function
- ✅ CI activated at `.github/workflows/ci.yml` (lint + test + audit + secret-scan + migrations)
- ✅ Migration ledger via `_migrations` + check-migrations `--verify-applied`
- ✅ README.md + `.env.example` + rewritten CLAUDE.md
- ✅ `routes/observability.js` proof-of-pattern for the server.js carve
- ✅ All 597 tests passing

---

## Open questions for you

1. **Doppler vs Railway-only?** Phase 1 assumes you'll use Doppler.
   If you only use Railway env, that's fine — but rotate secrets via the
   Railway UI and we lose the "rotate everywhere at once" benefit.

2. **Status page vendor?** Statuspage.io is the polished default
   ($29/mo), Instatus is leaner ($20/mo), and your own `/healthz` page
   served via the frontend is free. Pick before Phase 2.

3. **Should I keep `n8n-workflows/` in the repo?** Nothing imports it,
   it bloats the clone, and it embeds rotated secrets. Recommend
   `git rm -r n8n-workflows/` and `git tag pre-migration-snapshot` first
   so we keep the history.

4. **CI on PR with no Supabase secret?** Right now `--verify-applied`
   skips in CI. Want me to set up a staging Supabase project that CI
   can hit?
