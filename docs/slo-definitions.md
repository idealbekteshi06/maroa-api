# Service Level Objectives (SLOs)

Maroa's measurable promises. Tracked weekly via metrics; alerts fire when at risk.

## Public SLOs (we promise these to customers)

| Metric | Target | Measurement |
|---|---|---|
| **API uptime** | 99.5% (allows ~3.6h/mo downtime) | BetterUptime probes /health every 30s |
| **Daily ad-audit cron** | Runs successfully ≥99% of days | n8n execution log + Sentry |
| **Email deliverability** | ≥98% of weekly scorecards reach inbox | Resend dashboard |
| **First-content-generated** | <30 min from signup | Supabase event log |
| **Monthly auto-renewals** | 99% billing succeeds first try | Stripe dashboard |

## Internal SLOs (engineering targets)

| Metric | Target | Measurement |
|---|---|---|
| **/health endpoint p95 latency** | <200ms | metrics.exportPrometheus → Datadog |
| **Webhook endpoint p95 latency** | <3000ms | Same |
| **LLM call p95 latency** | <15s | Same |
| **Test suite duration** | <60s for full `npm test` | Local + CI |
| **Cost per active business per day** | <$0.30 | cost-report.js |
| **Sentry error rate** | <0.5% of all requests | Sentry |
| **Cron success rate** | ≥99% | n8n executions table |

## Error budget

If actual uptime = 99.7% (better than 99.5% target), we have a 0.2% budget to "spend" on risky changes.

If we burn through the budget (uptime drops to <99.5% in a 30-day window):
- Freeze new feature deploys
- Focus engineering exclusively on reliability
- Resume features only after 30 days of green metrics

## How to measure each SLO

### API uptime
```bash
# Check last 7 days from BetterUptime
curl https://uptime.betterstack.com/api/v2/monitors/<monitor_id>/sla -H "Authorization: Bearer $BU_TOKEN"
```

### Daily cron success rate
```sql
-- In Supabase SQL editor
SELECT
  DATE_TRUNC('day', logged_at) AS day,
  COUNT(*) FILTER (WHERE successful) * 100.0 / NULLIF(COUNT(*), 0) AS success_rate_pct
FROM ad_audit_results
WHERE logged_at >= NOW() - INTERVAL '30 days'
GROUP BY day ORDER BY day DESC;
```

### Email deliverability
Resend dashboard → Insights → Delivered % over last 30 days.

### Latency p95
Datadog or PostHog dashboard with `http_request_duration_ms{path}` histogram.

## Alert rules

| Condition | Severity | Action |
|---|---|---|
| /health 5xx for >2 min | SEV1 | Auto-page via BetterUptime SMS |
| Sentry error rate >2% in 5 min | SEV2 | Email/Slack |
| Daily cost spike >200% vs 7d avg | SEV2 | Email from cost-report.js |
| Cron failed >2 days in row | SEV2 | Sentry + manual investigation |
| Monthly uptime < 99.5% | SEV3 | Trigger error-budget freeze |

## Quarterly review

Every 90 days:
1. Pull actual numbers for each SLO
2. Compare to targets
3. Adjust targets if consistently exceeding (raise the bar) or missing (rethink scope)
4. Document changes in CHANGELOG-SLO.md

## Honest disclaimers

- These targets are achievable for 0-1000 customers on current stack
- Above 5000 customers, expect to revisit (current Railway plan probably won't scale)
- 99.99% uptime is NOT a reasonable target until business demands it (multi-region setup is expensive)
