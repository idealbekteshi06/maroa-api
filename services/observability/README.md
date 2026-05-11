# services/observability/

Structured logging + metrics + cost tracking. The "are we in trouble"
layer.

## Files

| File              | What                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `logger.js`       | JSON line logger with request_id correlation. Sentry breadcrumbs auto-attached.                                                            |
| `metrics.js`      | Prometheus-format metric collector. Counters, histograms, gauges. Exported via `GET /metrics`.                                             |
| `cost-tracker.js` | Per-business Anthropic spend logger. Writes to `llm_cost_logs`. Pricing table for Sonnet 4.5 / Opus 4.7 / Haiku 4.5 + cache-read discount. |
| `index.js`        | Facade: `observability.logger`, `observability.metrics`, `observability.costTracker`, `observability.metricsMiddleware()`.                 |

## Public API

```js
const observability = require('./services/observability');

// Logger (used everywhere)
observability.logger.info(route, businessId, message, data);
observability.logger.warn(...);
observability.logger.error(...);

// Metrics (auto-tracked via metricsMiddleware)
observability.metrics.increment('llm_calls_total', { skill, model });
observability.metrics.observeHistogram('http_request_ms', durationMs, { route, status });

// Cost tracker (wired into callClaude — see ADR-0003)
await observability.costTracker.track({ businessId, skill, model, usage, cost_usd, sbPost, logger });

// Cost report (POST /webhook/cost-report)
await observability.costTracker.buildCostReport({ sbGet, days: 7 });
```

## Where it plugs in

- `server.js:7-50` — Sentry init with PII scrubber + tracesSampleRate + release.
- `server.js:240` — `app.use(observability.metricsMiddleware())` auto-tracks every HTTP request.
- `server.js:633` — `callClaude` calls `costTracker.track()` on every 200.
- `lib/healthCheck.js` — `/healthz` + `/readyz` use the logger.
- `lib/tracing.js` — request-ID middleware sets Sentry scope.

See [ADR-0003](../../docs/adr/0003-cost-discipline-via-callclaude-facade.md)
for the cost tracking design.

## Future (Phase 5)

- OpenTelemetry trace export — scaffolded in `lib/otel.js`, opt-in via
  `OTEL_ENABLED=true` after installing `@opentelemetry/sdk-node`.
- Per-route span instrumentation via `lib/otel.withSpan()` (currently
  no-op; turns on globally once SDK is installed).
- Real-time cost dashboard in admin UI.
