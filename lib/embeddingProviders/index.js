'use strict';

/**
 * lib/embeddingProviders/index.js
 * ---------------------------------------------------------------------------
 * Provider registry + auto-selection.
 *
 * Selection order (highest-quality first):
 *   1. OpenAI text-embedding-3-small  (if OPENAI_API_KEY set)
 *   2. stub                            (always available — token-hash fallback)
 *
 * Future providers (Cohere, sentence-transformers HTTP, Voyage AI) plug in
 * by adding a file here + adding to the `PROVIDERS` list. Each provider
 * must export: `embed({text})`, `embedBatch({texts})`, `isConfigured()`.
 *
 * Picked once at boot via pick() — cached so we don't re-evaluate env on
 * every embed call.
 * ---------------------------------------------------------------------------
 */

const stub = require('./stub');
const openai = require('./openai');

const PROVIDERS = [
  { name: 'openai', impl: openai },
  { name: 'stub', impl: stub },
];

let _cached = null;

/**
 * Pick the highest-priority configured provider.
 * Returns { name, impl } — never null (stub is always available).
 *
 * The result is cached. Call _resetCache() in tests to force re-evaluation.
 */
function pick() {
  if (_cached) return _cached;
  for (const p of PROVIDERS) {
    if (p.impl.isConfigured()) {
      _cached = p;
      return _cached;
    }
  }
  // Safety net — stub is always configured, so we shouldn't get here
  _cached = PROVIDERS[PROVIDERS.length - 1];
  return _cached;
}

function getActiveProviderName() {
  return pick().name;
}

/**
 * Convenience: embed a single text using the active provider.
 */
async function embed(text) {
  const p = pick();
  return p.impl.embed({ text });
}

/**
 * Convenience: batch-embed an array of texts using the active provider.
 */
async function embedBatch(texts) {
  const p = pick();
  return p.impl.embedBatch({ texts });
}

function _resetCache() {
  _cached = null;
}

module.exports = {
  pick,
  embed,
  embedBatch,
  getActiveProviderName,
  PROVIDERS,
  _resetCache,
};
