# services/ad-optimizer/

Daily ad audit + decision engine for live Meta + Google Ads campaigns.

## What it does

For every active campaign every day at 08:00 UTC:

1. Pull current metrics + 14 days of `ad_performance_logs` + last 7
   decisions for anti-thrashing.
2. Run deterministic gates (significance, learning phase, compliance).
3. Run LLM synthesis (Sonnet executor + optional Opus advisor on Growth/
   Agency tiers) → decision + reason + new daily budget.
4. Persist to `ad_audit_results`. Apply decision:
   - `scale` / `optimize` → PATCH `ad_campaigns.daily_budget`
   - `pause` → PATCH `ad_campaigns.status='PAUSED'`
   - `refresh_creative` → fire WF26 event
   - `keep` → log only

## Public API

```js
const adOptimizer = require('./services/ad-optimizer')({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, Sentry });

adOptimizer.engine.auditOne({ campaignId, businessId, dryRun });
adOptimizer.engine.auditAllActive({ dryRun, limit });
adOptimizer.coldStartLaunch({ businessId, approvedConcept, coldStartRunId });
adOptimizer.registerRoutes({ app, apiError });
```

## Inngest triggers

- `ad-optimizer-daily` — `TZ=UTC 0 8 * * *`
- `manual-ad-audit` — event `maroa/manual.ad-audit`

## Files

| File | What |
|---|---|
| `engine.js` | Orchestrator. Pulls data, runs audit, persists, applies. |
| `index.js` | Factory + DI + route binding. |
| `launcher.js` | Cold-start launcher for new businesses. |
| `learning-phase-interlock.js` | Prevents `pause` during Meta learning phase. |
| `registerRoutes.js` | HTTP endpoint mounting. |

Prompt logic lives in `../prompts/ad-optimizer/`.

## Tests

`tests/ad-optimizer.test.js` — 22 named scenarios with i18n + multi-tier inputs.
`tests/fixtures/prompts/ad-optimizer.json` — golden fixtures for regression eval.
