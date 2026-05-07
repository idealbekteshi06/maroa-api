# Staging Environment Setup

How to provision a staging environment for Maroa. Required for A+ production discipline.

## Why staging exists

Today every push goes to production. One bad commit = customers see broken stuff.

After staging exists:
- `main` branch → auto-deploys to **staging**
- `production` branch → manually promoted from staging after smoke-test
- Customers only see code that was validated against real-shaped data

## Architecture

```
GitHub main branch
    ↓ (auto-deploy via GitHub Actions)
Railway: maroa-api-staging service
    ↓ uses
Supabase: staging-project (separate from prod)
    ↓ uses
n8n: staging environment (or webhook-test mode)

GitHub production branch
    ↓ (manual promote workflow)
Railway: maroa-api-production service
    ↓ uses
Supabase: prod-project
    ↓ uses
n8n: production cron workflows
```

## One-time setup (~30 min)

### Step 1 — Provision staging Supabase
1. https://supabase.com/dashboard → New Project → "maroa-staging"
2. Copy `Project URL` + `service_role` key
3. Run migrations 000-043: paste each into SQL editor + Run
4. Or use `scripts/restore-drill.sh` with staging URL/key
5. Save credentials in Railway (next step)

### Step 2 — Provision staging Railway service
1. Railway dashboard → New Service → Deploy from GitHub `main` branch
2. Service name: `maroa-api-staging`
3. Custom domain (optional): `staging-api.maroa.ai`
4. Add env vars (copy from production, replace these):
   ```
   SUPABASE_URL=<staging-project>
   SUPABASE_KEY=<staging-key>
   N8N_WEBHOOK_SECRET=<staging-secret-different-from-prod>
   NODE_ENV=staging
   SENTRY_DSN=<separate-staging-DSN>
   ```
5. Deploy → wait ~90s → curl `https://maroa-api-staging.up.railway.app/health` returns 200

### Step 3 — Configure GitHub Actions
1. GitHub repo → Settings → Secrets and variables → Actions
2. Add secrets:
   ```
   MAROA_STAGING_URL=https://maroa-api-staging.up.railway.app
   MAROA_STAGING_WEBHOOK_SECRET=<from step 2>
   ```
3. The `.github/workflows/load-test.yml` will use these on Monday morning

### Step 4 — Promote-to-production workflow
Create `.github/workflows/promote-prod.yml` (manual trigger):
```yaml
name: Promote staging → production
on:
  workflow_dispatch:
jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate staging health
        run: |
          curl -f https://maroa-api-staging.up.railway.app/health || exit 1
      - name: Run smoke test against staging
        run: |
          # ... synthetic test cases ...
      - name: Push to production branch
        run: |
          git config user.name "promote-bot"
          git config user.email "promote@maroa.ai"
          git push origin main:production
```

## Daily workflow after setup

```
1. Code changes → commit + push to main
2. CI runs (npm test + lint + audit) → must pass
3. Auto-deploy to STAGING (~90s)
4. You smoke-test staging manually OR wait for Monday's load test
5. Manually trigger "Promote to production" workflow when ready
6. Production deploys (~90s)
```

## Cost

- Staging Supabase: free tier sufficient (≤500MB, 50k MAU)
- Staging Railway: ~$5/mo for hobby plan
- **Total additional cost: ~$5/mo**

Worth every cent — prevents customer-facing breakage.

## What NOT to put in staging

- Real customer data (use synthetic seed data)
- Real Anthropic API key (use a separate test account or rate-limited key)
- Real Meta access tokens (use Meta Developer test users)
- Real Stripe/Paddle keys (test mode only)

## Validation

After setup, run:
```bash
# Should both return 200
curl https://maroa-api-production.up.railway.app/health
curl https://maroa-api-staging.up.railway.app/health

# Should both return version info
curl https://maroa-api-production.up.railway.app/
curl https://maroa-api-staging.up.railway.app/

# Verify staging uses different N8N_WEBHOOK_SECRET (should reject prod's)
curl -X POST https://maroa-api-staging.up.railway.app/webhook/health-check \
  -H "x-webhook-secret: <prod-secret>"
# Expected: 401
```
