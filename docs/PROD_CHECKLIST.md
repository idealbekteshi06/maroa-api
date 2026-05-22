# Production checklist (operator)

## Supabase migrations

Apply in SQL editor (in order), then verify:

- `migrations/079_wf11_smart_routing.sql`
- `migrations/080_quality_gate_runs.sql`

Run `npm run check-migrations:applied` locally against prod credentials in CI or staging first.

## Billing

Confirm Paddle dashboard SKUs match live prices: **Starter $29**, **Growth $59**, **Agency $99**.

## Railway healthcheck

1. Service **Root Directory** = repo root; config file `railway.toml` or `railway.json` at root.
2. Variable **`RAILWAY_HEALTHCHECK_TIMEOUT_SEC=600`** (required if deploys still fail at ~5m).
3. Deploy details show healthcheck from config file (file icon on `/healthz`).
4. See [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md).

## After deploy

1. `npm run check-migrations:applied` — ledger shows 079 + 080 applied.
2. `GET /readyz` — `checks.migrations.ok` true (or `missing_in_db` empty).
3. `GET /api/ops/platform` (authenticated) — `internal_dispatcher.registered` includes all Inngest paths.
4. Inngest dashboard — confirm `ops-*` + existing crons synced.
5. Dashboard — Integrations v2 shows `status: healthy|degraded|disconnected` per channel.
6. `GET /api/business/:id/llm-spend` — `anthropic_features.advisor_tool` + `web_search` caps visible.
7. Agency — `POST /api/business/:id/marketing-deep-dive` returns managed-agent session (optional smoke).

## Secret rotation (manual)

If `setup.sh` or `n8n-workflows/*.json` ever contained live keys, rotate Anthropic, Supabase service-role, Meta app secret, and Resend per `PUNCHLIST.md` CRITICAL §1.
