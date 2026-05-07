# Incident Response Runbook

When something breaks in production, follow this procedure. Goal: customer impact minimized in <15 minutes.

## Severity levels

| Level | Definition | Target response | Examples |
|---|---|---|---|
| **SEV1** | Service down for >50% of customers | Within 5 min | API returns 5xx, Supabase down, Railway crashed |
| **SEV2** | Partial degradation, some customers impacted | Within 15 min | Single endpoint fails, cron not firing, costs spike |
| **SEV3** | Single customer issue | Within 4 hours | One business sees wrong data, email delivery to one user |
| **SEV4** | Cosmetic / no customer impact | Next business day | Logs noisy, dashboard layout off |

## Detection sources

1. **Sentry** — exceptions caught and grouped (SEV2-3 default)
2. **BetterUptime / UptimeRobot** — synthetic checks fail (SEV1 if /health 5xx for >2 min)
3. **Railway logs** — restart loops, OOM kills
4. **cost-report.js** — daily script, alerts if spend > thresholds (SEV2)
5. **Customer report** — email or support ticket (SEV1-4 depending)

## Response procedure (SEV1)

```
T+0   Acknowledge: post in incident channel "INVESTIGATING <issue>"
T+2   Diagnose: check Railway dashboard, Sentry, /health endpoint
T+5   Mitigate: pick one of:
        a) Roll back: `git revert HEAD && git push` → Railway auto-redeploys (~90s)
        b) Disable broken feature via env flag (e.g. MAROA_ADVISOR_ENABLED=false)
        c) Take service into maintenance mode (Railway: pause)
T+10  Communicate: update status page + email affected customers
T+30  Confirm fix: synthetic + manual checks pass
T+24h Postmortem: write up what happened + how to prevent
```

## Response procedure (SEV2)

```
T+0    Acknowledge in Sentry / channel
T+15   Diagnose: read logs, reproduce locally if possible
T+60   Fix: ship a patch, run npm test, push to staging, validate
T+90   Promote to prod after staging passes
T+next-day  Postmortem if customer-impacting
```

## Common scenarios

### Railway service down
```
1. Check railway.app dashboard — is service "Crashed"?
2. Read latest deploy logs: `railway logs --tail`
3. If recent deploy: `git revert HEAD && git push`
4. If unknown cause: `railway redeploy` (sometimes restart fixes it)
5. Escalate if down >10 min: pause cron schedules in n8n to prevent backlog
```

### Anthropic 5xx / 429 rate limit
```
1. Sentry will show high error rate on /webhook/ad-optimizer-* etc.
2. If 429: Anthropic rate limit hit. Solution:
   - Pause non-critical cron (weekly-scorecard) temporarily
   - Wait for quota reset
   - Enable batch API in next deploy if not already
3. If 5xx: Anthropic incident. Subscribe to status.anthropic.com.
```

### Cost spike
```
1. cost-report.js fires alert
2. Identify: which skill / business?
3. If single business: investigate (loop bug? bad business profile?)
4. If single skill: check for prompt change in recent deploy
5. Mitigate: temporarily disable skill via env flag
6. Long-term: adjust thresholds, plan-tier gating, prompt caching
```

### Email deliverability drop
```
1. Customer reports "Maroa email not arriving"
2. Run: `node scripts/check-deliverability.js`
3. If SPF/DKIM/DMARC pass: check Resend dashboard for bounces/complaints
4. If config broken: fix DNS records via Cloudflare/registrar
5. Run inbox-placement test (mail-tester.com)
```

### Supabase migration failed
```
1. Customer signups failing, audits 500ing
2. Check Supabase SQL editor — schema log shows failed migration
3. Identify which migration broke (usually last applied)
4. Either:
   a) Roll back manually via DROP if safe
   b) Apply corrective migration (e.g. add missing column)
5. Re-run failed migration
```

## On-call (solo founder mode)

- **Sentry** alerts → email + Slack/SMS via Sentry's built-in integrations
- **BetterUptime** → calls phone if /health down for >5 min
- **Cost alerts** → daily 09:00 UTC email from cost-report.js
- Aim for ≤2 incidents/week needing actual response. More than that = systemic issue.

## Postmortem template

```markdown
# Postmortem: <short title>
**Date:** YYYY-MM-DD
**Severity:** SEV1/2/3/4
**Duration:** X minutes
**Author:** Name

## Summary
1-2 sentences on what happened.

## Timeline (UTC)
HH:MM — alert fired
HH:MM — diagnosed root cause
HH:MM — mitigated
HH:MM — confirmed fix
HH:MM — service fully restored

## Root cause
What actually broke. Code, config, third party, etc.

## Impact
N customers affected, X requests failed, $Y in failed cron runs.

## What went well
- Fast detection
- Quick mitigation

## What went poorly
- Took 20 min to find logs
- No alerting on this scenario

## Action items
- [ ] Add alert for X (owner, due date)
- [ ] Improve runbook for Y (owner, due date)
- [ ] Add test covering Z (owner, due date)
```

## Escalation contacts

```
Anthropic support:    https://status.anthropic.com  → file ticket if outage > 30 min
Railway support:      https://railway.app/help
Supabase support:     https://supabase.com/support
Resend support:       https://resend.com/help
Meta API support:     https://developers.facebook.com/support
```
