# Maroa.ai — API backend

AI-powered marketing automation for small businesses. This repo is the
Node.js + Express + Inngest backend that powers everything behind
[maroa.ai](https://maroa.ai).

If you're new here, read [CLAUDE.md](./CLAUDE.md) for the architectural
map and [LEARNINGS.md](./LEARNINGS.md) for the decision log.

---

## Stack at a glance

| Layer           | Tool                                                             |
| --------------- | ---------------------------------------------------------------- |
| HTTP API        | Node 18+ · Express 4                                             |
| Background jobs | [Inngest](https://www.inngest.com) — durable cron + event-driven |
| Database        | Supabase Postgres (PostgREST + service-role key)                 |
| LLM             | Anthropic Claude (Sonnet 4.5 · Opus 4.7 · Haiku 4.5)             |
| Image/Video     | Higgsfield AI (Cloud + FNF fallback)                             |
| Social          | Ayrshare + Meta Graph + LinkedIn UGC                             |
| Payments        | Paddle (primary) + Stripe (legacy)                               |
| Observability   | Sentry + Prometheus `/metrics` + structured JSON logs            |
| Deploy          | Railway                                                          |

---

## Quick start (local dev)

Prerequisites: Node 18+, a Supabase project, an Anthropic API key.

```bash
# 1. Clone + install
git clone <your-fork>
cd Maroa.ai
npm install

# 2. Copy the env template and fill in real values
cp .env.example .env
# minimum required: SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_KEY,
# N8N_WEBHOOK_SECRET, OAUTH_TOKEN_ENC_KEY (run: openssl rand -hex 32)

# 3. Apply migrations to your Supabase project
# (paste each migrations/NNN_*.sql into the Supabase SQL editor, in order)

# 4. Run the server with hot reload
npm run dev
# server listens on http://localhost:3000

# 5. Quick smoke test
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
```

The server boot **fails loudly** if any required env var is missing —
that's the zod schema in `lib/env.js`. To run without a complete env
during very early dev set `MAROA_ENV_SKIP_VALIDATION=1` (do **NOT** use
in production).

---

## Project layout

```
.
├── server.js                  HTTP bootstrap, route mounting, DI container
├── lib/                       Cross-cutting helpers
│   ├── env.js                 zod env schema — validated at boot
│   ├── costGuard.js           Per-business monthly $ cap on LLM endpoints
│   ├── webhookEvents.js       At-most-once webhook handler idempotency
│   ├── oauthCrypto.js         AES-256-GCM at-rest encryption for OAuth tokens
│   ├── circuitBreaker.js      Per-API failure-rate breakers
│   ├── healthCheck.js         /healthz + /readyz
│   ├── rateLimit.js           Upstash sliding-window
│   ├── tracing.js             Request-ID middleware (Sentry tags + headers)
│   └── validators.js          UUID, email, etc.
├── middleware/
│   ├── planGate.js            Feature gates (multi_workspace, paid_ads, ...)
│   ├── planLimits.js          Monthly usage caps (images, videos, captions)
│   └── requireAuthOrWebhookSecret.js
├── services/                  Business logic, one folder per capability
│   ├── inngest/               Durable schedulers + event handlers
│   ├── ad-optimizer/          WF02 daily ad audit + decision engine
│   ├── cro/                   Landing-page CRO audit + rewrites
│   ├── ai-seo/                AI-search citability audit
│   ├── voc/                   Voice-of-customer extraction
│   ├── forecasting/           ROAS + spend forecast (30/60/90)
│   ├── weekly-scorecard/      Sunday-night scorecard email
│   ├── creative-engine/       Daily creative generation
│   ├── cold-start/            Onboarding orchestrator (first-paid)
│   ├── higgsfield.js          Cloud + FNF image/video generation
│   ├── meta-marketing/        Meta Graph v21 client (campaigns + insights)
│   ├── google-ads-api/        Google Ads v18 client
│   ├── social-multi/          Ayrshare + Meta Graph publish layer
│   ├── paddle.js              Paddle checkout + webhook verification
│   ├── observability/         Structured logger, metrics, cost-tracker
│   ├── oauth/                 Meta + Google OAuth flows
│   └── prompts/               Versioned prompt modules (system + schemas)
├── migrations/                Numbered SQL migrations (NNN_*.sql)
├── tests/                     node --test unit + integration
├── scripts/                   One-off ops scripts
└── docs/                      Runbooks, SLOs, architecture
```

---

## NPM scripts

| Command                            | What it does                                       |
| ---------------------------------- | -------------------------------------------------- |
| `npm run dev`                      | Watch + reload — `node --watch server.js`          |
| `npm start`                        | Production start                                   |
| `npm test`                         | Run the test suite (`node --test tests/*.test.js`) |
| `npm run lint`                     | ESLint                                             |
| `npm run format`                   | Prettier write                                     |
| `npm run check-migrations`         | Sanity-check migration file naming + gaps          |
| `npm run check-migrations:applied` | Diff repo vs `_migrations` ledger in DB            |
| `npm run cost-report`              | Aggregate LLM spend per business / skill / model   |
| `npm run restore-drill`            | Run the backup restore drill                       |
| `npm run ops:audit`                | Full pre-deploy: migrations + lint + test + audit  |

---

## How requests flow

```
client ─▶ CORS ─▶ trust proxy ─▶ Sentry (PII-scrubbed) ─▶ requestId ─▶
   raw-body webhooks (Paddle, Stripe) ─▶ JSON parser ─▶
   /metrics middleware ─▶ /healthz + /readyz ─▶
   auth gate (requireAuthOrWebhookSecret) ─▶
   per-route: aiRateLimit + costGuard + planGate + zod schema ─▶
   handler ─▶ services/*  ─▶ callClaude (cost-tracked) ─▶ Anthropic
```

Inngest events fire in parallel for:

- daily ad optimizer (`TZ=UTC 0 8 * * *`)
- pacing alerts (every 4h)
- weekly scorecard (Sun 22:00 UTC)
- email lifecycle, citation tracker, autopilot brain, …
- one-off events (e.g. `maroa/content.publish.feedback-24h` for the 24h
  performance check that used to be an in-process setTimeout)

---

## Common operations

**Add a new env var**

1. Add it to `lib/env.js` zod schema with `optionalString()` or required string.
2. Add a line in `.env.example` with a comment.
3. Use `env.MY_VAR` (don't read `process.env` directly).

**Add a migration**

1. Create `migrations/NNN_short_name.sql`. Make it idempotent
   (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
2. Run `npm run check-migrations` locally — fails on gaps/duplicates.
3. Paste the SQL into the Supabase SQL editor for the target env.
4. Insert an audit row into `_migrations` with the filename + sha256
   checksum (`shasum -a 256 migrations/NNN_*.sql`).

**Add a new Inngest job**

1. Add the function to `services/inngest/functions.js` and export it.
2. POST your event from anywhere with
   `inngest.send({ name: 'maroa/...', data: {...} })`.
3. The Inngest dashboard at https://app.inngest.com/ shows live runs.

**Add a new LLM-using endpoint**

- Mount `aiRateLimit` AND `costGuard` on the path in `server.js`.
- Call `callClaude(prompt, model, max_tokens, { businessId, skill: 'my_skill' })`
  — that gives you retries, prompt-caching, cost tracking, budget enforcement.

---

## Security model

- All secrets in env vars (validated at boot). Doppler / Railway env for
  production. **Never** commit anything that matches `sk-`, `sb_`, `r8_`.
- OAuth tokens encrypted at rest via AES-256-GCM (`lib/oauthCrypto.js`,
  migration 056). Plaintext columns are scheduled for removal in
  migration 060 once the backfill completes.
- Webhook handlers (Paddle, Stripe) verify HMAC **and** enforce a 5-minute
  timestamp tolerance. `lib/webhookEvents.js` provides at-most-once
  semantics so retries are safe.
- OAuth `state` tokens bind to authenticated user_id + nonce + expiry —
  not just businessId — so a third party can't bind tokens to a victim's
  business row.
- Per-business monthly LLM spend cap (`lib/costGuard.js`) — soft-allow on
  telemetry outage, hard-block on confirmed overrun.

See [docs/security-policy.md](./docs/security-policy.md) for the full
threat model and rotation policy.

---

## Production checklist

Run [`docs/incident-runbook.md`](./docs/incident-runbook.md) on every
new deploy and every quarter. Critical items:

- [ ] All migrations in `migrations/` applied + recorded in `_migrations` ledger
- [ ] `OAUTH_TOKEN_ENC_KEY` set on Railway and rotated in Doppler / 1Password
- [ ] `scripts/encrypt-oauth-tokens.js` run after migration 056 applied
- [ ] Sentry DSN + `SENTRY_TRACES_SAMPLE_RATE` set
- [ ] Status page provisioned (statuspage.io / instatus / atlassian)
- [ ] On-call rota documented + PagerDuty / OpsGenie wired
- [ ] `/healthz` + `/readyz` checked from Railway health-check config
- [ ] `npm run restore-drill` passed in last 90 days

---

## License

MIT.
