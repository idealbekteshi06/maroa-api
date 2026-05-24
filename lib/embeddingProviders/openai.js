'use strict';

/**
 * lib/embeddingProviders/openai.js
 * ---------------------------------------------------------------------------
 * OpenAI text-embedding-3-small adapter.
 *
 * Why this model:
 *   - 1536-dim by default (good signal/cost tradeoff)
 *   - $0.02 per 1M tokens — cheapest mainstream embedding
 *   - Strong multilingual support (matters for Maroa's EU/Albania ICP)
 *   - 8191 token context — covers any single piece of content
 *
 * Environment:
 *   OPENAI_API_KEY  (required to enable this provider)
 *
 * Note on dim: migration 061 declares `vector(384)`. To use this provider
 * in production you must EITHER:
 *   - Resize the column to vector(1536) before backfill, OR
 *   - Use the `dimensions` request param to ask OpenAI for 384-dim output
 *     (loses ~1.5% quality vs full 1536 — acceptable trade)
 *
 * We default to dimensions=384 so the existing migration just works. Flip
 * to 1536 only if you also resize the column.
 * ---------------------------------------------------------------------------
 */

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIM = 384;

async function _httpPostJSON(url, body, apiKey) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, json };
}

/**
 * Embed a single piece of text.
 *
 * @returns Float32Array (length = `dim`) or null on failure
 */
async function embed({ text, apiKey, model = DEFAULT_MODEL, dim = DEFAULT_DIM, _httpPostJSONOverride } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  const _post = _httpPostJSONOverride || _httpPostJSON;
  const r = await _post(
    'https://api.openai.com/v1/embeddings',
    {
      model,
      input: text.slice(0, 30_000), // cap input to keep costs predictable
      dimensions: dim,
      encoding_format: 'float',
    },
    key
  );
  if (!r.ok || !r.json?.data?.[0]?.embedding) return null;
  return new Float32Array(r.json.data[0].embedding);
}

/**
 * Embed a batch of texts in a single request — much cheaper per item than
 * looping single embeds.
 */
async function embedBatch({ texts, apiKey, model = DEFAULT_MODEL, dim = DEFAULT_DIM, _httpPostJSONOverride } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (!Array.isArray(texts) || !texts.length) return [];
  const _post = _httpPostJSONOverride || _httpPostJSON;
  const sanitized = texts.map((t) => (typeof t === 'string' ? t.slice(0, 30_000) : '')).filter((t) => t.length > 0);
  if (!sanitized.length) return [];
  const r = await _post(
    'https://api.openai.com/v1/embeddings',
    {
      model,
      input: sanitized,
      dimensions: dim,
      encoding_format: 'float',
    },
    key
  );
  if (!r.ok || !Array.isArray(r.json?.data)) return null;
  return r.json.data.sort((a, b) => a.index - b.index).map((d) => new Float32Array(d.embedding));
}

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

module.exports = {
  embed,
  embedBatch,
  isConfigured,
  DEFAULT_MODEL,
  DEFAULT_DIM,
};
