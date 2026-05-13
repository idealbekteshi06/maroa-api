'use strict';

/**
 * lib/embeddingProviders/stub.js
 * ---------------------------------------------------------------------------
 * Deterministic stub embedding provider. NOT for production retrieval
 * quality — but it keeps the pgvector code path functional in tests +
 * dev environments without API keys.
 *
 * Algorithm: token-hash → 384-dim Float32, L2-normalized.
 * Deterministic: same input → same output.
 *
 * When to use:
 *   - tests (no API key required, no flakiness)
 *   - dev/staging where you'd rather not burn embedding credits
 *   - emergency fallback if the real provider is down
 *
 * Picked by lib/embeddingProviders/index.js#pick() when no real provider
 * is configured.
 * ---------------------------------------------------------------------------
 */

const DEFAULT_DIM = 384;

function _tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

async function embed({ text, dim = DEFAULT_DIM } = {}) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  const out = new Float32Array(dim);
  for (const tok of _tokenize(text)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) {
      h = (h * 31 + tok.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(h) % dim;
    out[idx] += 1;
  }
  // L2 normalize so cosine similarity = dot product
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

async function embedBatch({ texts, dim = DEFAULT_DIM } = {}) {
  if (!Array.isArray(texts)) return [];
  return Promise.all(texts.map((t) => embed({ text: t, dim })));
}

function isConfigured() {
  return true; // always available as a last-resort fallback
}

module.exports = {
  embed,
  embedBatch,
  isConfigured,
  DEFAULT_DIM,
};
