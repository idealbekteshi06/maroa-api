# Production checklist (operator)

## Supabase migrations

Apply in SQL editor (in order), then verify:

- `migrations/079_wf11_smart_routing.sql`
- `migrations/080_quality_gate_runs.sql`

Run `npm run check-migrations:applied` locally against prod credentials in CI or staging first.

## Billing

Confirm Paddle dashboard SKUs match live prices: **Starter $29**, **Growth $59**, **Agency $99**.

## After deploy

1. Inngest dashboard — confirm 5 `ops-*` functions + existing crons synced.
2. `GET /readyz` — Higgsfield + Inngest probes green.
3. Dashboard — Integrations card shows Meta/Google status (not demo competitors).
