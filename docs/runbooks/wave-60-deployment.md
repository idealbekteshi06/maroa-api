# Wave 60 deployment runbook

> **Goal:** Take Wave 60 from "code shipped" to "live for paying customers"
> in 15 minutes of operator time. After this runbook, the agency-grade
> master pipeline is callable via `POST /webhook/agency-generate`, audit
> rows are persisting, telemetry is flowing, and the feature flag is on.

**Pre-reqs:** Supabase project admin access, Railway env-var access,
ability to run `node` locally with project `.env`.

---

## TL;DR (the 5 commands)

```bash
# 1. Apply migration 064 — paste contents into Supabase SQL editor
cat migrations/064_agency_pipeline_runs.sql

# 2. Record it in the ledger (Supabase SQL editor)
#    INSERT INTO _migrations (filename, sha256) VALUES (
#      '064_agency_pipeline_runs.sql',
#      '<output of: shasum -a 256 migrations/064_agency_pipeline_runs.sql>'
#    );

# 3. Set env vars on Railway (or Doppler) — see §3 below
#    AGENCY_PIPELINE_ENABLED=1
#    OPENAI_API_KEY=...
#    META_AD_LIBRARY_TOKEN=...
#    GOOGLE_PLACES_API_KEY=...
#    SLACK_ALERT_WEBHOOK_URL=...

# 4. Preflight check (locally, with prod env loaded)
node scripts/wave-60-preflight.js

# 5. Smoke-test the live endpoint
curl -X POST https://maroa-api-production.up.railway.app/webhook/agency-generate \
  -H "Content-Type: application/json" \
  -H "X-Maroa-Auth: $N8N_WEBHOOK_SECRET" \
  -d '{"businessId":"fea4aae5-14b4-486d-89f4-33a7d7e4ab60",
       "goal":"Write an Instagram caption for our coffee shop",
       "channel":"instagram-post","industry":"cafe"}'
```

If that final `curl` returns `{"ok": true, ...}` with a `generation`
field — you're live.

---

## 1. Apply migration 064

**File:** [`migrations/064_agency_pipeline_runs.sql`](../../migrations/064_agency_pipeline_runs.sql)

Creates `agency_pipeline_runs` table with:

- `business_id` FK (UUID)
- `job_goal`, `channel`, `industry`
- detection + dispatch + composition + validation columns (all jsonb)
- `refused` boolean + `refusal_reason` text
- RLS: business-owner self-read, service-role write

**Apply:**

1. Open Supabase → SQL editor → New query
2. Paste full file contents
3. Run

**Record in ledger (separate query):**

```sql
INSERT INTO _migrations (filename, sha256, applied_at)
VALUES (
  '064_agency_pipeline_runs.sql',
  '<paste-checksum-here>',
  now()
);
```

Get checksum locally:

```bash
shasum -a 256 migrations/064_agency_pipeline_runs.sql
```

**Verify:**

```sql
SELECT * FROM _migrations WHERE filename = '064_agency_pipeline_runs.sql';
SELECT to_regclass('public.agency_pipeline_runs');  -- should return the OID
```

---

## 2. Set env vars on Railway

Open Railway → project → Variables.

### Required (pipeline will not run without these)

| Variable                  | Source     | Required? |
| ------------------------- | ---------- | --------- |
| `AGENCY_PIPELINE_ENABLED` | Set to `1` | YES       |

### Recommended (degrade gracefully if missing)

| Variable                  | Source                                        | Effect if missing              |
| ------------------------- | --------------------------------------------- | ------------------------------ |
| `OPENAI_API_KEY`          | platform.openai.com → API keys                | embeddings + reranker degraded |
| `META_AD_LIBRARY_TOKEN`   | developers.facebook.com → app → tokens (free) | corpus seed source unavailable |
| `GOOGLE_PLACES_API_KEY`   | console.cloud.google.com → APIs               | local-cohort seed unavailable  |
| `SLACK_ALERT_WEBHOOK_URL` | Slack → app → Incoming Webhooks               | refusal alerts won't fire      |

Railway restarts the service automatically when env vars change. Wait
~30s for the new container to come up before running step 4.

---

## 3. Preflight (local check)

```bash
cd /path/to/Maroa.ai
node scripts/wave-60-preflight.js
```

Pulls `.env` (or Doppler env), reports what's missing in one screen.

**Expected output when ready:**

```
1. Code surface     ✓ (all 7 files present)
2. Registry counts  ✓ (29 methodologies, 35 channels, 20 compliance, 7 specialists)
3. Environment      ✓ (all required + recommended set)
4. Migration 064    ✓ (applied)
5. Table reachable  ✓ (agency_pipeline_runs)
6. Smoke run        ✓ (dry pipeline OK)

PASS  0 failures, 0 warnings
Safe to flip AGENCY_PIPELINE_ENABLED=1
```

Exit code `0` = green light; `1` = something to fix.

---

## 4. /readyz remote check

```bash
curl -s https://maroa-api-production.up.railway.app/readyz | jq .checks.wave60
```

Expected when flag is on + registries load:

```json
{
  "ok": true,
  "counts": {
    "methodologies": 29,
    "channels": 35,
    "compliance": 20,
    "specialists": 7
  }
}
```

When flag is off, returns `{"ok": true, "skipped": true}`.

---

## 5. Smoke test the live endpoint

```bash
curl -X POST https://maroa-api-production.up.railway.app/webhook/agency-generate \
  -H "Content-Type: application/json" \
  -H "X-Maroa-Auth: $N8N_WEBHOOK_SECRET" \
  -d '{
    "businessId": "fea4aae5-14b4-486d-89f4-33a7d7e4ab60",
    "goal": "Write an Instagram caption for our coffee shop",
    "channel": "instagram-post",
    "industry": "cafe"
  }' | jq '{ok, refused, specialist: .specialist.id, generation: .generation, refusal_reason}'
```

**Expected:**

```json
{
  "ok": true,
  "refused": false,
  "specialist": "social-media-manager",
  "generation": "<some Instagram caption>",
  "refusal_reason": null
}
```

**Verify audit row landed:**

```sql
SELECT id, specialist_picked, refused, refusal_reason, created_at
FROM agency_pipeline_runs
ORDER BY created_at DESC LIMIT 5;
```

---

## 6. Compliance gate smoke test (should REFUSE)

```bash
curl -X POST https://maroa-api-production.up.railway.app/webhook/agency-generate \
  -H "Content-Type: application/json" \
  -H "X-Maroa-Auth: $N8N_WEBHOOK_SECRET" \
  -d '{
    "businessId": "fea4aae5-14b4-486d-89f4-33a7d7e4ab60",
    "goal": "Write a mortgage ad guaranteeing approval with no credit check",
    "channel": "meta-ads-image",
    "industry": "mortgage_broker"
  }' | jq '{ok, refused, refusal_reason}'
```

**Expected:**

```json
{
  "ok": false,
  "refused": true,
  "refusal_reason": "compliance: ..."
}
```

If this returns `ok: true`, the compliance gate is not firing — STOP and
investigate before letting customers near the endpoint.

---

## 7. Telemetry verification

```bash
curl -s https://maroa-api-production.up.railway.app/metrics | grep agency_pipeline
```

After a few requests, you should see:

```
agency_pipeline_calls_total{outcome="ok",specialist="social-media-manager"} N
agency_pipeline_calls_total{outcome="refused_compliance",specialist="performance-marketer"} N
agency_pipeline_refusals_total{reason="compliance"} N
agency_pipeline_duration_ms_count{...} N
agency_pipeline_manipulation_risk_count{...} N
```

---

## 8. Rollback (if something goes wrong)

The pipeline is feature-flag-gated. Rollback = flip the flag off:

```
AGENCY_PIPELINE_ENABLED=0
```

(or unset entirely). Railway restarts the container in ~30s. The route
will then return `503 feature_disabled` instead of running the pipeline.
The code itself stays deployed; only the surface is dark.

**Don't roll back migration 064 unless absolutely necessary** — the
audit table is empty until you flip the flag, so leaving it in place
costs nothing.

---

## Operator checklist (paste into your task tracker)

- [ ] Migration 064 applied (verified via `_migrations` ledger)
- [ ] `agency_pipeline_runs` table exists + RLS enabled
- [ ] `AGENCY_PIPELINE_ENABLED=1` set on Railway
- [ ] `OPENAI_API_KEY` set (or accept degraded corpus)
- [ ] `META_AD_LIBRARY_TOKEN` set (or accept degraded seed)
- [ ] `GOOGLE_PLACES_API_KEY` set (or accept degraded seed)
- [ ] `SLACK_ALERT_WEBHOOK_URL` set (or accept silent refusals)
- [ ] `scripts/wave-60-preflight.js` returns exit 0
- [ ] `/readyz` reports `wave60.ok: true`
- [ ] Happy-path curl returns `ok: true` + generation
- [ ] Compliance-violation curl returns `refused: true`
- [ ] `/metrics` shows `agency_pipeline_*` series
- [ ] At least one `agency_pipeline_runs` row written
- [ ] First customer task routed through the new pipeline (with rollback ready)

When the entire list is checked, production readiness is A+.
