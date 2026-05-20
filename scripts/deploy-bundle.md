# Ship the 2026-05-19 changes — operator runbook

Three independent ship targets. Do them in this exact order so nothing 404s.

---

## 1️⃣ Supabase — apply migrations 069-073 (~3 minutes)

The 5 migrations are already concatenated into a single file ready to
paste into the Supabase SQL Editor:

**File:** `/tmp/maroa-migrations-069-073.sql` (or rebuild any time with:
`cat migrations/069_idempotency_keys.sql migrations/070_jsonb_check_constraints.sql migrations/071_atomic_rpcs.sql migrations/072_computer_use_runs.sql migrations/073_oauth_plaintext_drop.sql > /tmp/maroa-migrations-069-073.sql`)

### Steps

1. Open <https://supabase.com/dashboard>
2. Select your Maroa project
3. Left sidebar → **SQL Editor** → **New query**
4. Paste the entire content of `/tmp/maroa-migrations-069-073.sql`
5. Click **Run**

### Expected outcome

- 069 → `idempotency_keys` table created
- 070 → 4 CHECK constraints added (with `NOTICE: table not present — skipping` if a target table doesn't exist yet — that's fine)
- 071 → 2 RPC functions registered (`cold_start_initialize`, `ad_optimizer_decision`)
- 072 → `computer_use_runs` table created
- 073 → ⚠️ This one **will RAISE** if the OAuth backfill hasn't completed yet. That's by design — it refuses to drop plaintext OAuth columns until every business has its encrypted counterpart.

### If migration 073 raises

You'll see:
```
Refusing to drop plaintext OAuth columns: N businesses still have unencrypted tokens.
Run scripts/encrypt-oauth-tokens.js first.
```

To complete the backfill (one-time):

```bash
cd ~/Desktop/Maroa.ai
OAUTH_TOKEN_ENC_KEY=$(openssl rand -hex 32)   # save this immediately — you can't recover it
node scripts/encrypt-oauth-tokens.js
```

Then re-run migration 073 alone in Supabase.

If you'd rather defer the OAuth-drop migration for now (e.g., you want to
verify the backfill manually first), just delete the 073 block from the
paste and re-run. Migrations 069-072 are independent of 073.

---

## 2️⃣ Backend — Railway deploy (~2 minutes)

The repo already has `.github/workflows/deploy-prod.yml` — manual-gated.

### Steps

1. Open <https://github.com/idealbekteshi06/maroa-api/pulls> → create PR
   from `design-pass-6/full-overhaul` → `main`
2. Wait for CI green (≤ 8 min)
3. Merge the PR
4. Open the repo → **Actions** tab → **Deploy — Production** workflow
5. Click **Run workflow** → pick `main` → click green **Run workflow** button
6. The first run requires you to set up the `production` GitHub
   Environment (Settings → Environments → New environment → name it
   `production` → add yourself as a required reviewer). After that, deploys
   require your one-click approval.

### Set env flags in Railway (Project → Variables)

Optional but recommended now that the code supports them:

```
ANTHROPIC_MEMORY_ENABLED       = 1
WEEKLY_SCORECARD_BATCH_ENABLED = 1
SLACK_ALERT_WEBHOOK_URL        = <your incoming-webhook URL>
# COMPUTER_USE_ENABLED         = leave UNSET until the runner-worker image is deployed
```

Railway redeploys automatically when env changes.

### Smoke-test after deploy

```bash
curl https://maroa-api-production.up.railway.app/healthz
# → 200 ok

curl https://maroa-api-production.up.railway.app/readyz
# → 200 ready  (with hard_failures: [], soft_warnings: maybe higgsfield)
```

If `/readyz` returns 503 with hard_failures, paste the response.

---

## 3️⃣ Frontend — Vercel deploy (~5 minutes, first time only)

The `frontend/` Next.js app isn't deployed anywhere yet. Vercel is the
right host for Next 15.

### One-time setup

```bash
cd ~/Desktop/Maroa.ai/frontend
npm i -g vercel       # one-time global install
vercel login          # browser flow
vercel                # interactive deploy
# → "Set up and deploy ~/Desktop/Maroa.ai/frontend? Y"
# → "Which scope?" → your account
# → "Link to existing project?" N
# → "Project name?" maroa
# → "In which directory is your code located?" ./
# → "Want to modify settings?" N
# (it builds and deploys to a preview URL)
```

### Set env vars (Vercel dashboard → Project → Settings → Environment Variables)

Add for **Production**:

```
NEXT_PUBLIC_SUPABASE_URL       = https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY  = <Supabase anon key — NOT service role>
NEXT_PUBLIC_API_URL            = https://maroa-api-production.up.railway.app
NEXT_PUBLIC_SITE_URL           = https://maroa.ai
```

Then promote the preview to production:

```bash
vercel --prod
```

### Point your DNS at Vercel

- Vercel dashboard → Project → Settings → Domains → Add `maroa.ai`
- Vercel will give you DNS records (one A record + one CNAME for www)
- Update them in your domain registrar (Namecheap / Cloudflare / etc.)
- TTL: ~1-30 minutes to propagate

---

## 4️⃣ End-to-end smoke test

After all three are live:

1. Open <https://maroa.ai>
2. Click **Sign in**
3. Enter `idealbekteshi06@gmail.com` (test account per CLAUDE.md §8)
4. Click the magic link in your inbox
5. You land on `/dashboard` (the new calm Today view)
6. You should see a real headline + (if any) pending approvals from your live workspace

If the dashboard renders but shows "Connect your first account to see real numbers", that's the first-run state — means the SSR fetch to the API succeeded but your workspace has no clients yet. Add one in `/dashboard/clients`.

If the dashboard shows mock data without the first-run banner, that's the API-unreachable fallback — your `NEXT_PUBLIC_API_URL` is wrong or Railway is down.

---

## Rollback plan

If something goes wrong:

- **Backend:** Railway dashboard → Deployments → click a previous deployment → "Redeploy". Takes ~60s.
- **Frontend:** Vercel dashboard → Deployments → click previous → "Promote to Production". Takes ~30s.
- **Supabase:** Migrations are mostly forward-only. 073 (OAuth drop) is the only destructive one. If you applied it accidentally, restore the dropped columns from a Supabase backup (Settings → Database → Backups → restore point-in-time). All other migrations (069-072) are additive and safe.

---

## What to tell me

When you're done, paste back any of:
- The full response from `/readyz` if it's not 200
- Any Supabase SQL Editor error
- A screenshot of the dashboard if it looks wrong
- A "✅ all green" if everything works

I'll either help debug or congratulate you accordingly.
