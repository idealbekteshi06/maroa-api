# ADR-0001: Migrate workflow runtime from n8n Cloud to Inngest

**Date:** 2026-04 · **Status:** Accepted · **Deciders:** Owner (solo)

## Context

The first version of Maroa ran on n8n Cloud with 28 JSON-defined workflows
covering content generation, ad optimization, social posting, retention
emails, etc. The decision driver was speed-of-iteration: visual node
editor, no deploy required for changes, free-tier hosting.

After ~3 months on n8n we hit hard ceilings:

- **No git history.** Workflow changes happened in the n8n UI; "what
  changed yesterday" was unanswerable without manual export.
- **No real debugging.** Failed runs surfaced as orange dots with
  truncated error messages. Reproducing a customer-specific failure
  meant cloning the workflow + injecting a fake input + re-running.
- **No durable scheduling.** Crons missed if the n8n instance was
  rebooting. We saw silent failures during n8n's rolling upgrades.
- **No native retries.** Implementing exponential backoff required
  hand-wiring "Wait" + "If" nodes that themselves could fail.
- **Pricing cliff.** Free tier capped at 5K executions/month; the next
  tier was $20/month → $50/month at projected volume.
- **No type safety + no tests.** Changes shipped to production without
  unit tests, integration tests, or PR review.

## Decision

Migrate every n8n workflow to native code in this repo (Node + Express)
with **Inngest** as the durable scheduler + event runtime.

Inngest gives us:

- **Code-defined functions** — `inngest.createFunction(opts, handler)`.
- **Durable retries.** Each `step.run()` is checkpointed; failures
  retry from the failed step, not the whole function.
- **`step.sleep('24h')`** — durable sleep that survives redeploys.
  This alone justified the migration: our 24h-after-publish performance
  feedback loop was lost on every Railway redeploy under the n8n setup.
- **First-class concurrency keys** — `concurrency: { key: 'event.data.businessId' }`
  for per-business serialization without manual locks.
- **Local dev + replay** — Inngest dev server runs locally; functions
  can be re-played from the dashboard with the same event payload.

## Alternatives considered

| Option                          | Why we didn't pick it                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Stay on n8n + add a debug layer | Doesn't solve the durability / cron / type issues.                                                                          |
| Bull / BullMQ / Cloud Run Tasks | More infra to run (Redis, retries, dashboards). Inngest delivers the whole thing as a service for ~$20/month at our volume. |
| Temporal                        | Excellent but ~2× the learning curve. Right answer at 100K customers, overkill at 50.                                       |
| AWS Step Functions              | Locked us into AWS for serverless workflows. We're on Railway.                                                              |
| Cron + Postgres job table       | Fine for 3 jobs, ungovernable at 28. Would have to re-implement Inngest's reliability features.                             |

## Consequences

**Positive:**

- Every workflow change goes through `git diff` + PR review.
- Failed jobs visible in Inngest dashboard with full step-level error.
- New workflows are ~3× faster to add (no JSON wiring, just a JS function).
- Unit tests possible — `tests/helpers/fakeInngest.js` drives functions
  synchronously.
- Cost ceiling went down (no per-execution Pay; Inngest is per-function).

**Negative:**

- Non-engineers (future hires) can't tweak prompts without a deploy.
  Mitigation: the prompt modules are now versioned + the registry is
  designed to support remote config later.
- ~3 weeks of focused work to migrate, fix bugs, and prove parity.
- One vendor dependency (Inngest). Mitigation: the function code is
  pure Node; Inngest is just the scheduler. If they fold or 10× pricing,
  swapping in Temporal or BullMQ is mechanical.

## Operational notes

- All Inngest functions live in `services/inngest/functions.js`.
- The legacy `n8n-workflows/` directory remains in the repo as an
  archive but **nothing imports it**. It will be `git rm -r`'d in a
  future PR after the test account has run on Inngest for ~30 days
  without rollback.
- Each function's failures go to the `inngest_dlq` table (migration 058)
  via `services/inngest/dlqRecorder.js`. See ADR-0006.
