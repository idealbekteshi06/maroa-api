'use strict';

/**
 * services/inngest/client.js
 * ----------------------------------------------------------------------------
 * Inngest client (durable workflow engine).
 *
 * Activation:
 *   Set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in Railway env vars.
 *   Without keys, the client still works in dev mode (against
 *   `npx inngest-cli dev` at localhost:8288).
 *
 * Why we picked Inngest over staying on n8n Cloud:
 *   - Durable execution: every step.run() checkpoints state. If Anthropic
 *     times out at step 4, retries from step 4 (not from scratch).
 *   - Per-business concurrency control via { concurrency: { key: '...' } }.
 *   - Free tier covers ~50 customers; n8n Cloud's tiers cap at ~5 customers
 *     before usage tiers spike.
 *   - Workflows live in code (this folder), not in n8n's database.
 * ----------------------------------------------------------------------------
 */

const { Inngest } = require('inngest');

const inngest = new Inngest({
  id: 'maroa-ai',
  // eventKey + signingKey are read from env automatically
  // (INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY).
});

module.exports = { inngest };
