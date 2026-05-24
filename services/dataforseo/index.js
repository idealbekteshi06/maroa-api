'use strict';

/**
 * services/dataforseo/index.js
 * ---------------------------------------------------------------------------
 * Real DataForSEO client. Two endpoints we use:
 *
 *   POST /v3/serp/google/ai_mode/live/advanced
 *      → AI Mode SERP results (cited URLs in Google AI Mode for a query)
 *
 *   POST /v3/ai_optimization/llm_responses/google/live/advanced
 *      → LLM Mentions API (ChatGPT + AIO citation tracking with full
 *        response text + cited URLs + AI search volume)
 *
 * Auth: Basic auth with login:password (NOT bearer). Per-call cost ~$0.10.
 * Rate limit: 30 simultaneous requests, 2000/min.
 *
 * Public API:
 *   query({ prompt, engine, location_code? })
 *     → { ok, response_text, cited_urls, raw, api_cost_usd }
 *
 *   isConfigured() → boolean
 * ---------------------------------------------------------------------------
 */

const HOST = 'api.dataforseo.com';

function isConfigured() {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader() {
  if (!isConfigured()) return null;
  const token = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function postJson(path, body) {
  const auth = authHeader();
  if (!auth) return { ok: false, status: 0, reason: 'DATAFORSEO_LOGIN/PASSWORD not configured' };

  try {
    const res = await fetch(`https://${HOST}${path}`, {
      signal: AbortSignal.timeout(30000),
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      // DataForSEO accepts an array of tasks per request — even for one query.
      body: JSON.stringify(Array.isArray(body) ? body : [body]),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.status_code >= 40000) {
      return { ok: false, status: res.status, reason: json?.status_message || `HTTP ${res.status}`, raw: json };
    }
    return { ok: true, status: res.status, raw: json };
  } catch (e) {
    return { ok: false, status: 0, reason: e.message };
  }
}

/**
 * Map our internal engine string to DataForSEO's path.
 *   chatgpt   → /v3/ai_optimization/llm_responses/google/live/advanced (uses 'ChatGPT' as model param)
 *   google_aio → same endpoint with 'Google AI Overview' model
 *   ai_mode   → /v3/serp/google/ai_mode/live/advanced (different shape)
 */
async function query({ prompt, engine = 'chatgpt', location_code = 2840 /* US */, language_code = 'en' }) {
  if (!isConfigured()) return null;

  if (engine === 'ai_mode') {
    // SERP-style endpoint: returns cited URLs that appear in Google AI Mode
    const r = await postJson('/v3/serp/google/ai_mode/live/advanced', {
      keyword: String(prompt).slice(0, 500),
      location_code,
      language_code,
      device: 'desktop',
    });
    if (!r.ok) return null;
    const task = r.raw?.tasks?.[0];
    const result = task?.result?.[0];
    const items = result?.items || [];
    const urls = items
      .filter((i) => i.type === 'ai_overview' || i.cited_urls)
      .flatMap((i) => i.cited_urls || (i.url ? [i.url] : []));
    return {
      engine: 'ai_mode',
      response_text: items.find((i) => i.type === 'ai_overview')?.text || '',
      cited_urls: Array.from(new Set(urls)),
      api_cost_usd: Number(task?.cost) || 0.001,
      api_source: 'dataforseo',
      raw: r.raw,
    };
  }

  // ChatGPT or Google AI Overview via the LLM Responses endpoint
  const llmModel = engine === 'google_aio' ? 'Google AI Overview' : 'ChatGPT';
  const r = await postJson('/v3/ai_optimization/llm_responses/google/live/advanced', {
    user_prompt: String(prompt).slice(0, 500),
    llm_name: llmModel,
    language_code,
    location_code,
  });
  if (!r.ok) return null;

  const task = r.raw?.tasks?.[0];
  const result = task?.result?.[0];
  const items = result?.items || [];
  const responseText = items
    .map((i) => i.text || i.title || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
  const citedUrls = Array.from(new Set(items.flatMap((i) => i.cited_urls || (i.url ? [i.url] : []))));

  return {
    engine,
    response_text: responseText,
    cited_urls: citedUrls,
    api_cost_usd: Number(task?.cost) || 0.1,
    api_source: 'dataforseo',
    raw: r.raw,
  };
}

module.exports = { query, isConfigured };
