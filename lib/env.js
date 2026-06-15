'use strict';

/**
 * lib/env.js — Boot-time environment validation.
 *
 * Parses process.env through a zod schema. On missing required vars the
 * process exits with a named error so misconfigured deploys never reach
 * production traffic. Optional vars are clearly marked so dev environments
 * can run without third-party integrations.
 *
 * Critical rule: NO fallback defaults to production URLs / live API keys.
 * If you need a default for local dev, set it in .env.example and let dev
 * machines opt in.
 *
 * Usage:
 *   const env = require('./lib/env').parse();
 *   // env.SUPABASE_URL, env.ANTHROPIC_KEY, ...
 */

const { z } = require('zod');

const clean = (v) => (typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').trim() : v);
const cleanedString = () => z.preprocess((v) => clean(v ?? ''), z.string());
const optionalString = () => cleanedString().optional();

const schema = z
  .object({
    // Runtime
    NODE_ENV: cleanedString().default('production'),
    PORT: z.preprocess((v) => Number(v) || 3000, z.number().int().positive()).default(3000),

    // Supabase — REQUIRED in production, never default to prod URL
    SUPABASE_URL: cleanedString().refine((v) => /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v), {
      message: 'SUPABASE_URL must be a valid https://<project>.supabase.co URL',
    }),
    SUPABASE_KEY: cleanedString().refine(
      (v) => typeof v === 'string' && v.length >= 20,
      'SUPABASE_KEY required (service role key, ≥20 chars)'
    ),
    SUPABASE_SERVICE_ROLE_KEY: optionalString(),

    // Anthropic — REQUIRED
    ANTHROPIC_KEY: optionalString(),
    ANTHROPIC_API_KEY: optionalString(),

    // Webhook auth — REQUIRED for inter-service calls
    N8N_WEBHOOK_SECRET: cleanedString().refine(
      (v) => typeof v === 'string' && v.length >= 16,
      'N8N_WEBHOOK_SECRET must be ≥16 chars'
    ),

    // Sentry / observability
    SENTRY_DSN: optionalString(),
    SENTRY_TRACES_SAMPLE_RATE: z
      .preprocess((v) => (v === undefined || v === '' ? 0.1 : Number(v)), z.number().min(0).max(1))
      .default(0.1),
    RELEASE: optionalString(),

    // Optional integrations — soft-required (feature-flagged)
    SERPAPI_KEY: optionalString(),
    REPLICATE_API_KEY: optionalString(),
    PEXELS_API_KEY: optionalString(),
    RESEND_API_KEY: optionalString(),
    FROM_EMAIL: cleanedString().default('onboarding@resend.dev'),
    OPENAI_API_KEY: optionalString(),
    PINECONE_API_KEY: optionalString(),
    PINECONE_HOST: optionalString(),
    RUNWAY_API_KEY: optionalString(),
    GOOGLE_AI_API_KEY: optionalString(),
    TWILIO_ACCOUNT_SID: optionalString(),
    TWILIO_AUTH_TOKEN: optionalString(),
    TWILIO_WHATSAPP_FROM: cleanedString().default('whatsapp:+14155238886'),

    // Payments
    PADDLE_API_KEY: optionalString(),
    PADDLE_ENV: cleanedString().default('sandbox'),
    PADDLE_WEBHOOK_SECRET: optionalString(),
    PADDLE_STARTER_PRICE_ID: optionalString(),
    PADDLE_GROWTH_PRICE_ID: optionalString(),
    PADDLE_AGENCY_PRICE_ID: optionalString(),
    STRIPE_WEBHOOK_SECRET: optionalString(),

    // OAuth — required only if the integration is enabled
    GOOGLE_OAUTH_CLIENT_ID: optionalString(),
    GOOGLE_OAUTH_CLIENT_SECRET: optionalString(),
    GOOGLE_OAUTH_REDIRECT_URI: optionalString(),
    GOOGLE_ADS_DEVELOPER_TOKEN: optionalString(),
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: optionalString(),
    META_APP_ID: optionalString(),
    META_APP_SECRET: optionalString(),
    META_OAUTH_REDIRECT_URI: optionalString(),
    FRONTEND_URL: cleanedString().default('https://maroa-ai-marketing-automator.lovable.app'),

    // OAuth-at-rest encryption key (32+ random bytes hex, used for pgp_sym_encrypt)
    OAUTH_TOKEN_ENC_KEY: optionalString(),

    // Rate-limit / cache
    UPSTASH_REDIS_REST_URL: optionalString(),
    UPSTASH_REDIS_REST_TOKEN: optionalString(),

    // Cost-cap overrides — picked up by lib/costGuard.js
    COST_CAP_FREE_USD: optionalString(),
    COST_CAP_STARTER_USD: optionalString(),
    COST_CAP_GROWTH_USD: optionalString(),
    COST_CAP_AGENCY_USD: optionalString(),

    // External HTTP defaults
    EXTERNAL_HTTP_TIMEOUT_MS: z.preprocess((v) => Number(v) || 15000, z.number().int().positive()).default(15000),

    // Inngest
    INNGEST_EVENT_KEY: optionalString(),
    INNGEST_SIGNING_KEY: optionalString(),

    // Orchestrator shared secret (legacy)
    ORCHESTRATOR_SECRET: optionalString(),

    // Wave 60 — agency-grade master pipeline. Defaults OFF so deploys are
    // safe; flip to "1" or "true" once the operator runbook has been run
    // (migration 064 applied, env vars set, smoke test passed).
    AGENCY_PIPELINE_ENABLED: optionalString(),

    // ─── External-write "go live" flags ──────────────────────────────────
    // Each gates a real money-spending / outward-facing action and defaults
    // OFF (dry-run). Declared here so they're validated + documented at boot;
    // their live/dry-run state is logged via liveFlagsLogLine(). Defaults are
    // unchanged — unset still means dry-run. See .env.example.
    META_AD_LAUNCH_LIVE: optionalString(),
    META_PUBLISH_LIVE: optionalString(),
    GOOGLE_ADS_LIVE: optionalString(),
    TIKTOK_ADS_LIVE: optionalString(),
    HIGGSFIELD_DEFAULT_CREDITS: optionalString(),

    // Auth lockdown (2026-05-13 audit) — when unset, /api/* routes require
    // a Bearer JWT. Flip to "1" only during a documented migration window
    // for legacy n8n callers. Each fallback hit increments
    // auth_legacy_fallback_total{route} so we can confirm the path is idle
    // before flipping it off permanently.
    LEGACY_USERID_FALLBACK_ALLOWED: optionalString(),

    // ─── Audit 2026-05-18 H6: env vars previously read direct from
    // process.env are now centralized here so missing keys fail fast at
    // boot (Rule 1). When adding a new external API key, list it here.

    // Higgsfield (image/video gen)
    HIGGSFIELD_API_KEY_ID: optionalString(),
    HIGGSFIELD_API_KEY_SECRET: optionalString(),
    HIGGSFIELD_BEARER_TOKEN: optionalString(),
    HIGGSFIELD_API_BASE: optionalString(),
    HIGGSFIELD_FNF_BASE: optionalString(),

    // Image gen alternates
    IDEOGRAM_API_KEY: optionalString(),
    NANO_BANANA_API_KEY: optionalString(),
    LEONARDO_API_KEY: optionalString(),

    // Alerting / ops
    SLACK_ALERT_WEBHOOK_URL: optionalString(),
    ALERT_EMAIL_TO: optionalString(),
    PAGERDUTY_INTEGRATION_KEY: optionalString(),

    // Ayrshare social-multi
    AYRSHARE_API_KEY: optionalString(),
    AYRSHARE_WEBHOOK_SECRET: optionalString(),

    // Shopify public app — per-store OAuth + GraphQL Admin API (pinned 2026-01).
    // SHOPIFY_API_SECRET is used for BOTH the OAuth token exchange and webhook
    // HMAC verification. SHOPIFY_SYNC_LIVE is declared in LIVE_FLAGS below.
    SHOPIFY_API_KEY: optionalString(),
    SHOPIFY_API_SECRET: optionalString(),
    SHOPIFY_OAUTH_REDIRECT_URI: optionalString(),
    SHOPIFY_APP_URL: optionalString(),
    SHOPIFY_SCOPES: optionalString(),
    SHOPIFY_API_VERSION: optionalString(),
    SHOPIFY_SYNC_LIVE: optionalString(),

    // Hard caps (audit 2026-05-18 M6)
    GROUNDING_CACHE_MAX_ENTRIES: optionalString(),
    METRICS_MAX_CARDINALITY: optionalString(),

    // Railway-injected — surfaced so consumers don't read process.env directly
    RAILWAY_GIT_COMMIT_SHA: optionalString(),
    RAILWAY_ENVIRONMENT: optionalString(),
  })
  .passthrough();

let cachedEnv = null;

function parse() {
  if (cachedEnv) return cachedEnv;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // zod v4 renamed `.error.errors` → `.error.issues`. Fall back to either
    // so a future bump or downgrade can't crash boot with a vague TypeError.
    const issues = result.error.issues || result.error.errors || [];
    const formatted = issues.map((e) => `  • ${(e.path || []).join('.')}: ${e.message}`).join('\n');
    const allowMissing = process.env.MAROA_ENV_SKIP_VALIDATION === '1';
    const msg = `\n[env] Boot-time environment validation failed:\n${formatted}\n`;
    if (allowMissing) {
      console.warn(
        msg + '\n[env] MAROA_ENV_SKIP_VALIDATION=1 set — continuing with raw process.env. DO NOT use in production.\n'
      );
      // Pre-fill numeric defaults that the schema would have applied so
      // downstream callers don't crash on `req.setTimeout(undefined, …)`
      // and similar "expected a number, got undefined" errors during
      // local dev with the skip flag on.
      cachedEnv = {
        ...process.env,
        EXTERNAL_HTTP_TIMEOUT_MS: Number(process.env.EXTERNAL_HTTP_TIMEOUT_MS) || 15000,
        SENTRY_TRACES_SAMPLE_RATE: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
        PORT: Number(process.env.PORT) || 3000,
      };
      return cachedEnv;
    }
    console.error(msg);
    process.exit(1);
  }
  // Anthropic key: accept either ANTHROPIC_KEY or ANTHROPIC_API_KEY but require one
  const env = result.data;
  if (!env.ANTHROPIC_KEY && !env.ANTHROPIC_API_KEY) {
    console.error('[env] ANTHROPIC_KEY or ANTHROPIC_API_KEY must be set');
    if (process.env.MAROA_ENV_SKIP_VALIDATION !== '1') process.exit(1);
  }
  env.ANTHROPIC_KEY = env.ANTHROPIC_KEY || env.ANTHROPIC_API_KEY || '';
  assertOAuthEncKeyInProduction(env);
  // Coerce the external-write flags to real booleans (default OFF / dry-run).
  for (const key of LIVE_FLAGS) {
    env[key] = String(env[key] || '').toLowerCase() === 'true';
  }
  cachedEnv = env;
  return cachedEnv;
}

// Outward-facing action gates — each defaults OFF (dry-run). Keep in sync with
// .env.example. These are intentionally separate from secrets: they don't
// fail boot when unset, they just run dry, and liveFlagsLogLine() makes the
// state visible instead of silent (audit 2026-05 wiring fix).
const LIVE_FLAGS = [
  'META_AD_LAUNCH_LIVE',
  'META_PUBLISH_LIVE',
  'GOOGLE_ADS_LIVE',
  'TIKTOK_ADS_LIVE',
  'SHOPIFY_SYNC_LIVE',
];

/** State of each go-live flag: [{ key, live: boolean }]. */
function describeLiveFlags(envObj) {
  const e = envObj || parse();
  return LIVE_FLAGS.map((key) => ({ key, live: e[key] === true }));
}

/** One-line boot summary so an operator can see at a glance what will actuate. */
function liveFlagsLogLine(envObj) {
  return (
    '[env] external-write flags: ' +
    describeLiveFlags(envObj)
      .map(({ key, live }) => `${key}=${live ? 'LIVE' : 'DRY-RUN'}`)
      .join('  ')
  );
}

function assertOAuthEncKeyInProduction(env) {
  const isProd = env.NODE_ENV === 'production' || String(env.RAILWAY_ENVIRONMENT || '').toLowerCase() === 'production';
  if (!isProd) return;

  const key = String(env.OAUTH_TOKEN_ENC_KEY || '').trim();
  if (!key) {
    console.error(
      '\n[env] OAUTH_TOKEN_ENC_KEY is required in production.\n' + '       Generate with: openssl rand -hex 32\n'
    );
    process.exit(1);
  }
  // oauthCrypto hex-decodes this to a 32-byte AES-256 key, so it must be
  // exactly 64 hex chars. A 32-char value decodes to 16 bytes and throws at
  // every encrypt/decrypt — reject it at boot instead of letting it pass here.
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    console.error(
      `\n[env] OAUTH_TOKEN_ENC_KEY must be 64 hex chars (32 bytes) in production; got length ${key.length}.\n` +
        '       Generate with: openssl rand -hex 32\n'
    );
    process.exit(1);
  }
}

module.exports = {
  parse,
  schema,
  assertOAuthEncKeyInProduction,
  LIVE_FLAGS,
  describeLiveFlags,
  liveFlagsLogLine,
};
