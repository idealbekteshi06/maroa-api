# services/weekly-scorecard/

Sunday-night weekly performance scorecard + LLM commentary + email.

## What it does

Every Sunday at 22:00 UTC, for every active business:

1. Pull last 14 days of `ad_performance_logs` + `daily_stats`.
2. Build `scorecardData`: week + previous_week + deltas + best/worst campaign.
3. **Free tier**: stop here, send plain HTML email with numbers only.
4. **Growth/Agency**: call Claude for narrative commentary (headline +
   summary + recommendation). Routes through quality-gate (`scorecard_text`
   thresholds) — slop-heavy narratives get one voice-polish repair attempt.
5. Render HTML email, send via Resend.
6. Persist to `weekly_scorecards` (carries `commentary._quality_gate`
   metadata + `polished_summary` if repair fired).

## Public API

```js
const ws = require('./services/weekly-scorecard')({ sbGet, sbPost, sbPatch, callClaude, extractJSON, sendEmail, logger, Sentry });

await ws.engine.generateForBusiness({ businessId, dryRun, sendEmailToOwner });
await ws.engine.generateForAll({ dryRun });
ws.registerRoutes({ app, apiError });
```

## Inngest

- `weekly-scorecard-sun-22-utc` — `TZ=UTC 0 22 * * 0`
- `manual-weekly-scorecard` — event `maroa/manual.weekly-scorecard`

## Files

| File | What |
|---|---|
| `engine.js` | Orchestrator + LLM call + quality-gate + email + persist. |
| `index.js` | Factory + DI. |
| `registerRoutes.js` | HTTP mounting. |

Prompt + scoring data builder in `../prompts/weekly-scorecard/`.

## Tests

`tests/weekly-scorecard.test.js` + e2e suite.
