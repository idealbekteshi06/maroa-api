# Security Policy

## Threat model

Maroa stores: business data, ad performance metrics, customer reviews, payment customer-IDs (via Paddle/Stripe). Worst-case breach = competitor sees a customer's marketing strategy + customer LTV. Bad but not catastrophic.

NOT stored: passwords (OAuth-only), credit cards (Paddle/Stripe vault), social security or government IDs.

## Practices we follow

### Code
- ✅ All dependencies updated weekly via Dependabot (auto-PR, manual merge)
- ✅ `npm audit` runs in CI; high-severity vulnerabilities block merge
- ✅ Secrets never committed (verified via `.gitignore` + Railway env-var injection)
- ✅ Rate limiting on every public endpoint via express-rate-limit (IPv6-safe)
- ✅ Webhook auth via `N8N_WEBHOOK_SECRET` header on every internal call
- ✅ All Supabase queries use parameterized values (no string concatenation in SQL)

### Authentication & authorization
- ✅ Customer login via Supabase Auth (email/password + OAuth)
- ✅ Service-role Supabase key only used server-side
- ✅ Webhook auth uses constant-time string comparison (no timing leak)
- ✅ Rate limits prevent brute-force attempts on /webhook/*
- ✅ Sensitive endpoints check business_id ownership before returning data

### Data handling
- ✅ Supabase RLS enabled on every table; service role bypass for backend only
- ✅ Customer review text anonymized at ingestion (first name + last initial)
- ✅ Email replies scoped per business (Gmail OAuth grants only that business's mailbox)
- ✅ No third-party tracking/analytics in customer-facing surfaces
- ✅ All HTTPS-only (Railway enforces); HSTS implicit

### Operational
- ✅ Production deploys are auditable via git log (every commit signed eventually)
- ✅ Production secrets never visible in logs (no `console.log(secret)` patterns)
- ✅ Sentry captures errors but scrubs PII patterns (configured in Sentry dashboard)

## Practices we should follow (gaps)

| Practice | Status | Priority | Effort |
|---|---|---|---|
| Secret rotation policy (90-day) | ❌ not implemented | Med | 1 day |
| 2FA on Railway/Supabase/GitHub admin accounts | ⚠️ unverified | High | 30 min |
| Penetration test (annual) | ❌ never done | Low (no $$) | $5k cost |
| SAST scan in CI (e.g., Snyk, GitHub CodeQL) | ❌ | Med | 1 hour to add |
| Customer-data export (GDPR right of access) | ❌ no formal process | Med | 1 day |
| Customer-data deletion (right to erasure) | ✅ /webhook/data-deletion-request | — | done |
| Privacy policy + terms of service public | ⚠️ unverified | High | docs work |
| Vendor security review (Anthropic, Resend, etc.) | ❌ | Low | 2 hours |

## Reporting a vulnerability

**Do NOT open a public GitHub issue.**

Email: security@maroa.ai (or `idealbekteshi06@gmail.com` until that mailbox is set up).

Include:
- Description
- Steps to reproduce
- Impact (what an attacker could do)
- Suggested fix (optional)

We commit to:
- Acknowledge within 48 hours
- Triage within 7 days
- Fix critical issues within 30 days
- Credit disclosure (if reporter wants it) on a public security page

No bug bounty program currently.

## Compliance posture

| Standard | Status | Notes |
|---|---|---|
| GDPR (EU customers) | Mostly | Right-to-erasure ✅, Data-export ⚠️, DPO not appointed |
| CCPA (California) | Mostly | Data deletion ✅, "Sell my data" toggle N/A (we don't sell) |
| SOC 2 | ❌ | Not required for our scale; revisit at 1000+ customers |
| HIPAA / Health data | ❌ | Maroa isn't designed for medical data; reject if customer asks |
| Meta App Review | ✅ | Compliance endpoints (deauth, data deletion) shipped |

## Data retention

| Data type | Retention | Deletion trigger |
|---|---|---|
| Business profiles | Forever (until customer cancels) | Customer self-serve delete or 90d after subscription end |
| Ad performance logs | 24 months | Auto-purge older |
| LLM cost logs | 12 months | Auto-purge older |
| Customer reviews (mined) | 6 months | Customer can request earlier deletion |
| Sentry events | 90 days (Sentry plan default) | Auto |
| Application logs | 30 days (Railway default) | Auto |

## Annual security review checklist

```
[ ] All dependencies up-to-date (no critical CVEs)
[ ] All staff have 2FA on production tools
[ ] Secrets rotated in last 90 days
[ ] Restore drill ran in last 90 days (scripts/restore-drill.sh)
[ ] Privacy policy / TOS up to date
[ ] No new vendor without security review
[ ] DR procedure tested
[ ] Incident postmortems reviewed for systemic issues
[ ] Customer-facing security page accurate
```
