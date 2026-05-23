# Production checklist (operator)

## Supabase migrations

Apply in SQL editor (in order), then verify:

- `migrations/079_wf11_smart_routing.sql`
- `migrations/080_quality_gate_runs.sql`
- `migrations/081_voc_trigger_positioning.sql`
- `migrations/082_wf10_video_jobs_model.sql`
- `migrations/083_video_ab_tests.sql`
- `migrations/084_soul_ids.sql`
- `migrations/085_industry_benchmarks.sql`

Run `npm run check-migrations:applied` locally against prod credentials in CI or staging first.

Optional seed data (service role):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-all.js
```

## Required production env

- `OAUTH_TOKEN_ENC_KEY` — **required** in production (`openssl rand -hex 32`). Boot fails without it.
- `N8N_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_KEY`, Anthropic key — validated at boot via `lib/env.js`.
- `PADDLE_WEBHOOK_SECRET` — required for live billing webhooks (raw-body route registered before JSON parser).

## Billing

Confirm Paddle dashboard SKUs match live prices: **Starter $25**, **Growth $59**, **Agency $99**.

Verify `PADDLE_*_PRICE_ID` env vars match the Paddle dashboard.

## Railway healthcheck

1. Service **Root Directory** = repo root; config file `railway.toml` or `railway.json` at root.
2. Variable **`RAILWAY_HEALTHCHECK_TIMEOUT_SEC=600`** (required if deploys still fail at ~5m).
3. Deploy details show healthcheck from config file (file icon on `/healthz`).
4. See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md).

## After deploy

1. `npm run check-migrations:applied` — ledger shows **079–085** applied.
2. `GET /healthz` — HTTP 200.
3. `GET /readyz` — `status: "ready"`, `checks.migrations.ok` true (or `missing_in_db` empty).
4. `GET /api/billing/plans` — HTTP 200 with `plans` object.
5. `node scripts/synthetic-canary.js` — all public probes pass (or GitHub Actions synthetic-canary workflow green).
6. `GET /api/ops/platform` (authenticated) — `internal_dispatcher.registered` includes all Inngest paths.
7. Inngest dashboard — confirm `ops-*` + existing crons synced.
8. Dashboard — Integrations v2 shows `status: healthy|degraded|disconnected` per channel.
9. `GET /api/business/:id/llm-spend` — `anthropic_features.advisor_tool` + `web_search` caps visible.
10. Agency — `POST /api/business/:id/marketing-deep-dive` returns managed-agent session (optional smoke).

## Secret rotation (manual)

If `setup.sh` or `n8n-workflows/*.json` ever contained live keys, rotate Anthropic, Supabase service-role, Meta app secret, and Resend per `PUNCHLIST.md` CRITICAL §1.
