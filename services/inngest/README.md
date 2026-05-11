# services/inngest/

Durable scheduler + event runtime. Replaces all n8n Cloud workflows.
See [ADR-0001](../../docs/adr/0001-migrate-off-n8n-to-inngest.md).

## What it does

Every cron job + every event-driven async workflow lives here. Each
function is wrapped in `step.run()` so failures retry from the failed
step (not the whole function). Per-business concurrency keys serialize
work without distributed locks.

## Files

| File             | What                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `client.js`      | `inngest.createClient()` factory + auth wiring.                                               |
| `functions.js`   | All 22 functions registered. `withDLQ()` helper auto-attaches `onFailure: dlqHandler({...})`. |
| `dlqRecorder.js` | `onFailure` callback that writes to `inngest_dlq` (migration 058).                            |

## Registered functions

Cron:

- `ad-optimizer-daily` — 08:00 UTC
- `pacing-alerts-every-4h` — every 4h
- `weekly-scorecard-sun-22-utc` — Sun 22:00 UTC
- `wf1-daily-sweep-hourly` — every hour
- `wf1-measure-fallbacks-hourly` — every hour
- `wf1-overnight-batch-submit-nightly` — 02:00 UTC
- `wf1-overnight-batch-apply-poll` — every 15 min during US morning
- `anthropic-batch-reconcile-poll` — every 30 min
- `creative-engine-daily` — daily
- `creative-engine-evaluate-6h` — every 6h
- `measurement-health-probe-daily` — daily
- `autopilot-brain-daily` — daily
- `email-lifecycle-process-15m` — every 15 min
- `citation-tracker-daily` — daily
- `competitor-watch-every-4h` — every 4h
- `wf13-weekly-synthesis` — Sun 23:00 UTC

Event:

- `content-publish-feedback-24h` — `maroa/content.publish.feedback-24h` (24h sleep + score)
- `cold-start-run` — `maroa/cold-start.run`
- `cold-start-resume` — `maroa/cold-start.resume`
- `manual-ad-audit` / `manual-pacing-alerts` / `manual-weekly-scorecard` — dashboard test triggers

## Dead-letter queue

After retries exhausted, the `onFailure` callback persists to
`inngest_dlq` so terminal failures are recoverable and dashboardable.
Ops query:

```sql
SELECT function_id, count(*) FROM inngest_dlq
WHERE resolved_at IS NULL
GROUP BY function_id ORDER BY count(*) DESC;
```

## Local dev

```bash
npx inngest-cli@latest dev
```

Inngest dev server starts at `localhost:8288` and discovers functions
via the `/api/inngest` endpoint (mounted by the SDK).

## Tests

`tests/inngest-functions.test.js` + `tests/helpers/fakeInngest.js` for
synchronous drive of individual functions. `tests/e2e-publish-pipeline.test.js`
exercises `content-publish-feedback-24h` end-to-end.
