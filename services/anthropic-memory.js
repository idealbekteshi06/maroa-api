'use strict';

/**
 * services/anthropic-memory.js
 * ---------------------------------------------------------------------------
 * Anthropic Memory (public beta) integration. Memory lives inside the
 * Claude Managed Agents harness — it gives an agent persistent state across
 * sessions, scoped to a memory_id you control.
 *
 * Beta header: managed-agents-2026-04-01
 *
 * Pilot scope: Maroa already has Pinecone (semantic embeddings) + a custom
 * memorySystem.js. We do NOT replace either. We augment WF-15 (AI Brain) with
 * Anthropic Memory as a fast first-party conversational memory layer for the
 * customer-facing chat. Pinecone stays for embeddings/long-term recall;
 * Memory holds the active session state.
 *
 * Endpoints used:
 *   POST   /v1/managed-agents/memory/sessions         (create memory session)
 *   GET    /v1/managed-agents/memory/sessions/:id     (read state)
 *   POST   /v1/managed-agents/memory/sessions/:id/append   (append a fact)
 *   DELETE /v1/managed-agents/memory/sessions/:id     (forget — privacy/GDPR)
 *
 * NB: Anthropic Memory paths are public-beta and may move. Wrap defensively.
 * Override via env if Anthropic publishes a different path:
 *   ANTHROPIC_MEMORY_BASE   = /v1/managed-agents/memory  (default)
 * ---------------------------------------------------------------------------
 */

const https = require('https');

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
const MEMORY_BASE = process.env.ANTHROPIC_MEMORY_BASE || '/v1/managed-agents/memory';

function rawHttp(method, urlStr, headers, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        let parsed = txt;
        try { parsed = JSON.parse(txt); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed, raw: txt });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Anthropic Memory request timeout')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createMemoryService({ apiKey, logger, http }) {
  if (!apiKey) throw new Error('createMemoryService: ANTHROPIC_KEY required');

  // http is injectable so tests can mock the HTTPS layer without
  // patching globals. Defaults to the real implementation.
  const _http = typeof http === 'function' ? http : rawHttp;

  function headers() {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': MANAGED_AGENTS_BETA,
      'Content-Type': 'application/json',
    };
  }

  async function createSession({ businessId, userId, namespace = 'wf15', metadata = {} } = {}) {
    const r = await _http(
      'POST',
      `${ANTHROPIC_API_BASE}${MEMORY_BASE}/sessions`,
      headers(),
      {
        external_id: `${namespace}:${businessId}:${userId || ''}`,
        metadata: { businessId, userId, namespace, ...metadata },
      }
    );
    if (r.status < 200 || r.status >= 300) {
      logger?.warn('anthropic-memory', businessId, 'createSession failed', { status: r.status, body: r.raw?.slice?.(0, 400) });
      const e = new Error(`Memory createSession HTTP ${r.status}`);
      e.status = r.status;
      e.body = r.body;
      throw e;
    }
    return r.body;
  }

  async function getSession(sessionId) {
    const r = await _http(
      'GET',
      `${ANTHROPIC_API_BASE}${MEMORY_BASE}/sessions/${encodeURIComponent(sessionId)}`,
      headers()
    );
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new Error(`Memory getSession HTTP ${r.status}`);
    return r.body;
  }

  async function appendFact({ sessionId, fact, kind = 'observation', importance = 0.5 }) {
    const r = await _http(
      'POST',
      `${ANTHROPIC_API_BASE}${MEMORY_BASE}/sessions/${encodeURIComponent(sessionId)}/append`,
      headers(),
      { fact, kind, importance }
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`Memory appendFact HTTP ${r.status}`);
    return r.body;
  }

  async function deleteSession(sessionId) {
    const r = await _http(
      'DELETE',
      `${ANTHROPIC_API_BASE}${MEMORY_BASE}/sessions/${encodeURIComponent(sessionId)}`,
      headers()
    );
    if (r.status < 200 || r.status >= 300 && r.status !== 404) {
      throw new Error(`Memory deleteSession HTTP ${r.status}`);
    }
    return { ok: true };
  }

  /**
   * Find or create a session for (businessId, namespace, userId).
   * Idempotent: if a session already exists for the external_id, returns it.
   */
  async function ensureSession({ businessId, userId, namespace = 'wf15' }) {
    const externalId = `${namespace}:${businessId}:${userId || ''}`;
    try {
      const existing = await _http(
        'GET',
        `${ANTHROPIC_API_BASE}${MEMORY_BASE}/sessions?external_id=${encodeURIComponent(externalId)}`,
        headers()
      );
      const list = existing.body?.data || existing.body?.sessions || [];
      if (list[0]) return list[0];
    } catch { /* fall through to create */ }
    return await createSession({ businessId, userId, namespace });
  }

  return {
    createSession,
    getSession,
    appendFact,
    deleteSession,
    ensureSession,
    constants: { MANAGED_AGENTS_BETA, MEMORY_BASE },
  };
}

module.exports = { createMemoryService, MANAGED_AGENTS_BETA };
