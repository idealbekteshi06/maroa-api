# Observability Setup

How to wire Maroa's metrics into a real dashboard tool.

## What you get out-of-the-box (no external service needed)

The `services/observability/` module exports:
- **Structured JSON logs** — every flow logs as parseable JSON
- **Prometheus-format /metrics endpoint** — at `https://maroa-api-production.up.railway.app/metrics`
- **Cost tracker** — every LLM call recorded to `llm_cost_logs` table
- **Custom metrics** — counters, gauges, histograms via `metrics.increment()`

This is enough for log-grep + manual SQL. To get DASHBOARDS, plug into Datadog or PostHog.

## Option A — Datadog (recommended for full observability)

**Cost:** Free tier limited; ~$15/host/mo paid. ~$30/mo total.

### Setup (one-time, ~30 min)

1. Sign up at datadoghq.com → free trial
2. Get API key
3. Install Datadog agent on Railway as a sidecar:
   ```yaml
   # railway.toml
   [[services]]
   name = "datadog-agent"
   image = "gcr.io/datadoghq/agent:latest"
   env = { DD_API_KEY = "$DATADOG_API_KEY", DD_SITE = "datadoghq.com" }
   ```
4. Add to maroa-api env: `DD_TRACE_ENABLED=true` + `DD_AGENT_HOST=datadog-agent`
5. Datadog auto-discovers `/metrics` endpoint and starts scraping

### Dashboards to create
- **Overview**: requests/sec, error rate, p95 latency, active businesses
- **Cost**: spend per skill per day, spend per business per day, model mix
- **Skills health**: ad-optimizer success rate, voice-polish slop reduction, quality-gate ship/retry/reject ratio

### Alerts to create
- p95 latency > 5s for 5 min → SEV2
- Error rate > 2% for 5 min → SEV2
- Cost per hour > $5 → SEV2
- Daily cost > 200% of 7d avg → SEV2
- /health 5xx for 2 min → SEV1

## Option B — PostHog (simpler, marketing-focused)

**Cost:** Free up to 1M events/mo.

PostHog is product-analytics first; observability is secondary. Good for tracking customer behavior + funnel conversion, OK for system metrics.

### Setup
1. Sign up at posthog.com
2. `npm install posthog-node`
3. Add to server.js:
   ```js
   const { PostHog } = require('posthog-node');
   const ph = new PostHog(process.env.POSTHOG_API_KEY);
   ph.capture({ distinctId: businessId, event: 'audit_complete', properties: { score, tier } });
   ```
4. Build funnels in PostHog UI

### Best for
- Tracking which features customers use
- Funnel: signup → first content → first ad → conversion
- Retention cohorts

### Worst for
- Real-time SLO tracking (latency, errors)
- Cost tracking
- Infrastructure monitoring

## Option C — BetterUptime (just uptime + status page)

**Cost:** Free for 10 monitors.

Minimal but covers the most important customer-facing thing: "is it up?"

### Setup
1. betteruptime.com → New Monitor → HTTP/HTTPS
2. URL: `https://maroa-api-production.up.railway.app/health`
3. Frequency: 30s
4. Add SMS contact for SEV1 alerts
5. Create a public status page at `status.maroa.ai`

## Recommended combo for Maroa today

**Phase 1 (do now, ~15 min):** BetterUptime — covers SEV1 detection, gives status page  
**Phase 2 (do at 10 customers):** PostHog — track adoption + retention  
**Phase 3 (do at 100 customers):** Datadog — full observability for cost + perf

## Self-hosted alternative

If you don't want to pay for SaaS observability, run:
- Grafana + Prometheus + Loki self-hosted on Railway (~$10/mo)
- Plumber tools (cstate, statping) for status page

This is more work to set up but cheaper at scale. Most startups don't bother — pay the $30-50/mo for SaaS to focus on customers.

## What metrics matter for Maroa

Top 5 to watch daily:
1. **Cost per business per day** (target: < $0.30)
2. **Active businesses** (gauge)
3. **Cron success rate per day** (target: > 99%)
4. **Email deliverability** (target: > 98%)
5. **First-content-generated time** (target: < 30 min from signup)

If any drops below target for 7 days, investigate.
