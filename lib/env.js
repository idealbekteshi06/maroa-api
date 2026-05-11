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
    SUPABASE_KEY: cleanedString().min(20, 'SUPABASE_KEY required (service role key)'),
    SUPABASE_SERVICE_ROLE_KEY: optionalString(),

    // Anthropic — REQUIRED
    ANTHROPIC_KEY: optionalString(),
    ANTHROPIC_API_KEY: optionalString(),

    // Webhook auth — REQUIRED for inter-service calls
    N8N_WEBHOOK_SECRET: cleanedString().min(16, 'N8N_WEBHOOK_SECRET must be ≥16 chars'),

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
  })
  .passthrough();

let cachedEnv = null;

function parse() {
  if (cachedEnv) return cachedEnv;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.errors.map((e) => `  • ${e.path.join('.')}: ${e.message}`).join('\n');
    const allowMissing = process.env.MAROA_ENV_SKIP_VALIDATION === '1';
    const msg = `\n[env] Boot-time environment validation failed:\n${formatted}\n`;
    if (allowMissing) {
      console.warn(
        msg + '\n[env] MAROA_ENV_SKIP_VALIDATION=1 set — continuing with raw process.env. DO NOT use in production.\n'
      );
      cachedEnv = { ...process.env };
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
  cachedEnv = env;
  return cachedEnv;
}

module.exports = { parse, schema };
