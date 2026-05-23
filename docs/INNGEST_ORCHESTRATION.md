# Inngest orchestration (production)

Maroa uses **Inngest** as the sole production scheduler. `n8n-workflows/` and `scripts/legacy/` are historical only.

## Design principles

1. **Few durable crons** — fan-out inside one function per cadence, not 20+ per-business n8n loops.
2. **Plan gates** — `starter` gets crisis monitoring; `growth` / `agency` get LLM-heavy ops (strategy, brand memory, growth lever, analytics).
3. **Sync fan-outs** — `/webhook/ops-*-all` return real counts for observability (no `setImmediate` fire-and-forget).
4. **Autopilot absorbs narrative** — daily brief references `crisis_status` and `growth_engine_recommendation`; does not duplicate crisis LLM runs.

## Schedule matrix (UTC)

| Inngest ID                       | Cron         | Webhook                                 | Audience   |
| -------------------------------- | ------------ | --------------------------------------- | ---------- |
| `ops-analytics-snapshots-daily`  | `0 6 * * *`  | `/webhook/ops-analytics-snapshots-all`  | growth+    |
| `measurement-health-probe-daily` | `0 7 * * *`  | `/webhook/measurement-health-probe-all` | all active |
| `ops-daily-health-bundle`        | `30 7 * * *` | `/webhook/ops-daily-health-all`         | paid       |
| `ad-optimizer-daily`             | `0 8 * * *`  | ad audit                                | paid       |
| `autopilot-brain-daily`          | `0 8 * * *`  | daily brief                             | all active |
| `ops-weekly-maintenance`         | `30 5 * * 0` | brand memory + strategy                 | growth+    |
| `wf13-weekly-synthesis`          | `0 7 * * 0`  | weekly synthesis                        | all active |
| `weekly-scorecard-sun-22-utc`    | `0 22 * * 0` | scorecard email                         | paid       |
| `ops-growth-engine-monday`       | `0 9 * * 1`  | Monday lever                            | growth+    |
| `ops-monthly-reports`            | `0 8 1 * *`  | analytics report email                  | growth+    |

## Legacy webhook inventory

| Legacy path                         | Status          | Inngest home                    |
| ----------------------------------- | --------------- | ------------------------------- |
| `crisis-check`                      | Manual OK       | `ops-daily-health-bundle`       |
| `weekly-strategy-update`            | Manual OK       | `ops-weekly-maintenance`        |
| `brand-memory-train`                | Manual OK       | `ops-weekly-maintenance`        |
| `growth-engine`                     | Manual OK       | `ops-growth-engine-monday`      |
| `analytics-snapshot`                | Per-biz manual  | `ops-analytics-snapshots-daily` |
| `analytics-report`                  | Per-biz manual  | `ops-monthly-reports`           |
| `email-sequence-process`            | **Do not cron** | `email-lifecycle-process-15m`   |
| `master-agent` / `master-agent-all` | **Retired**     | `autopilot-brain-daily`         |
| n8n free-tier upsell                | **Retired**     | —                               |

## Code map

- `services/ops-maintenance/index.js` — fan-out + per-business runners
- `routes/analytics.js` — `runSnapshotForBusiness`, `runReportForBusiness`
- `services/inngest/functions.js` — cron registry
- `lib/internalDispatcher.js` — loopback for Inngest steps
