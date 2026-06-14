# Operator actions — required to fully activate the 2026-06-10 audit remediation

Everything fixable in code is **done, tested (1721/1721), and lint-clean**. The two
items below cannot be performed by a coding agent — they require access to
external systems (your live Supabase database and third-party provider consoles).
They are deployment/credential actions, not code defects. This file is the single
source of truth for completing them.

---

## 1. Apply the two new migrations (Supabase SQL editor) — SECURITY-URGENT

The app talks to Supabase only through PostgREST, which cannot run DDL, so there
is no in-app auto-runner (by design).

### Option A — one command (recommended)

Grab your Supabase direct-connection string (Project Settings → Database →
Connection string), then:

```bash
npm install                 # pulls the newly-declared `pg` dependency
DATABASE_URL='postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres' npm run db:migrate:dry   # preview
DATABASE_URL='postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres' npm run db:migrate       # apply
```

The runner applies every migration not yet in the `_migrations` ledger, in
order, records each + its checksum, takes an advisory lock so two runners can't
race, and stops on the first failure. Safe to re-run (already-applied files are
skipped). It only runs when you invoke it — never on boot/deploy.

### Option B — manual paste (no connection string needed)

Apply these **in order**:

1. Open Supabase → SQL Editor.
2. Paste the full contents of **`migrations/091_rls_tenant_isolation.sql`**, Run.
   - Closes the cross-tenant **public-read** hole (`business_profiles` + ~20 tables
     readable by the anon key the frontend ships). This is the most urgent item.
3. Paste the full contents of **`migrations/092_fix_atomic_rpcs_and_errors.sql`**, Run.
   - Fixes the cold-start / ad-optimizer atomic RPCs (were throwing on every call)
     and creates the missing `errors` table.
4. (Optional, recommended) record each in the ledger so `check-migrations
--verify-applied` stays accurate:

   ```sql
   insert into _migrations (filename, checksum, applied_at)
   values ('091_rls_tenant_isolation.sql', '<sha256-of-file>', now()),
          ('092_fix_atomic_rpcs_and_errors.sql', '<sha256-of-file>', now())
   on conflict (filename) do update set checksum = excluded.checksum, applied_at = now();
   ```

   (`shasum -a 256 migrations/091_*.sql` for the checksum.)

   > Note (2026-06-11): these two files were renumbered from 086/087 — the
   > merge with main collided with main's own 086/087. If you already applied
   > them under the old numbers, re-running under the new names is harmless
   > (both are idempotent), but update any old-name ledger rows to the new
   > filenames so `--verify-applied` doesn't flag them as missing.

Both files are idempotent-safe and wrapped in transactions; re-running is harmless.

---

## 2. Rotate the previously-leaked secrets (provider consoles)

These keys appear in git history, so **rotation at the provider is the only fix** —
no code change can revoke a key on someone else's servers. Full checklist (with
links) is in `PUNCHLIST.md` (prefixes now redacted from that file). Rotate, then
update the value in Railway env:

- [ ] Anthropic — `ANTHROPIC_KEY`
- [ ] Supabase service-role — `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Replicate — `REPLICATE_API_KEY`
- [ ] SerpAPI — `SERPAPI_KEY`
- [ ] Pexels — `PEXELS_API_KEY`
- [ ] Meta app secret — `META_APP_SECRET`
- [ ] Upstash Redis — `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

> ⚠️ Incident 2026-06-11: production Upstash REST calls are failing (every
> `rl.limit()` errors after ~6s of SDK retries), which made dashboard quick
> actions hang and the frontend show "Connection error" toasts. The backend
> now fails open instead of hanging, but **rate limiting is degraded until
> the Railway `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` values are
> updated to match the current Upstash database**. Verify after updating:
> `curl -s "$UPSTASH_REDIS_REST_URL/ping" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"`
> should return `{"result":"PONG"}`, and the Railway logs should stop printing
> `[rateLimit] Upstash unavailable`.

---

## 3. (When ready) flip the live-ad actuator on

The ad-optimizer now pushes pause/scale decisions to Meta/Google, but it is
**dry-run by default**. After you've verified behavior in dry-run, set on Railway:

- `META_AD_LAUNCH_LIVE=true`
- `GOOGLE_ADS_LIVE=true`
- (optional) `META_APP_SECRET` set → enables `appsecret_proof` on Meta calls.

Until these are `true`, every actuator call returns `{ dry_run: true }` and touches
no live ad account.
