'use strict';

/**
 * services/managed-agent.js
 * ---------------------------------------------------------------------------
 * Anthropic Claude Managed Agents (public beta) — fully managed agent harness
 * with secure sandboxing, built-in tools, and SSE streaming.
 *
 * Beta header: managed-agents-2026-04-01
 * Pilot scope: WF-15 (AI Brain) — runs the orchestrator as a managed agent.
 * Existing orchestrator stays as the fallback path.
 *
 * Endpoints used (defensively wrapped — paths overridable via env):
 *   POST   /v1/managed-agents/agents              (create agent)
 *   GET    /v1/managed-agents/agents              (list)
 *   POST   /v1/managed-agents/agents/:id/sessions (run a session)
 *   GET    /v1/managed-agents/sessions/:id        (poll)
 *   POST   /v1/managed-agents/sessions/:id/messages (append message; SSE supported)
 *   POST   /v1/managed-agents/sessions/:id/cancel (cancel)
 *
 * Public API:
 *   ensureAgent({ name, instructions, tools, files }) -> { agent_id, ... }
 *   runSession({ agentId, message, businessId, stream?, onEvent? }) -> { session_id, message? }
 *   pollSession(sessionId) -> {...}
 *   cancelSession(sessionId)
 * ---------------------------------------------------------------------------
 */

const https = require('https');

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
const AGENTS_BASE = process.env.ANTHROPIC_MANAGED_AGENTS_BASE || '/v1/managed-agents';

function rawHttp(method, urlStr, headers, body, timeoutMs = 120000) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Managed agent request timeout')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function createManagedAgentService({ apiKey, logger, http }) {
  if (!apiKey) throw new Error('createManagedAgentService: ANTHROPIC_KEY required');

  // http is injectable so tests can mock the HTTPS layer without globals.
  const _http = typeof http === 'function' ? http : rawHttp;

  function headers() {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': MANAGED_AGENTS_BETA,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create or fetch an agent by external_id (idempotent).
   *   name:         human-readable agent name
   *   instructions: system-prompt-equivalent
   *   tools:        array of Anthropic tool defs (optional)
   *   model:        defaults to claude-opus-4-7
   */
  async function ensureAgent({ externalId, name, instructions, tools = [], model = 'claude-opus-4-7', metadata = {} }) {
    if (!externalId) throw new Error('ensureAgent: externalId required');
    // Try to find an existing agent with this external_id
    try {
      const list = await _http(
        'GET',
        `${ANTHROPIC_API_BASE}${AGENTS_BASE}/agents?external_id=${encodeURIComponent(externalId)}`,
        headers()
      );
      const agents = list.body?.data || list.body?.agents || [];
      if (agents[0]) return agents[0];
    } catch { /* continue to create */ }

    const r = await _http(
      'POST',
      `${ANTHROPIC_API_BASE}${AGENTS_BASE}/agents`,
      headers(),
      {
        external_id: externalId,
        name: name || externalId,
        instructions,
        tools,
        model,
        metadata,
      }
    );
    if (r.status < 200 || r.status >= 300) {
      logger?.warn('managed-agent', null, 'create agent failed', { status: r.status, body: r.raw?.slice?.(0, 400) });
      throw new Error(`ensureAgent HTTP ${r.status}`);
    }
    return r.body;
  }

  async function runSession({ agentId, message, businessId, memorySessionId, files, stream = false, onEvent }) {
    if (!agentId) throw new Error('runSession: agentId required');
    if (!message) throw new Error('runSession: message required');
    const payload = {
      message: { role: 'user', content: message },
      metadata: { businessId },
    };
    if (memorySessionId) payload.memory_session_id = memorySessionId;
    if (files && files.length) payload.files = files;

    if (!stream) {
      const r = await _http(
        'POST',
        `${ANTHROPIC_API_BASE}${AGENTS_BASE}/agents/${encodeURIComponent(agentId)}/sessions`,
        headers(),
        payload
      );
      if (r.status < 200 || r.status >= 300) throw new Error(`runSession HTTP ${r.status}`);
      return r.body;
    }

    // SSE streaming path
    return new Promise((resolve, reject) => {
      const u = new URL(`${ANTHROPIC_API_BASE}${AGENTS_BASE}/agents/${encodeURIComponent(agentId)}/sessions`);
      const req = https.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        headers: { ...headers(), Accept: 'text/event-stream' },
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errBody = '';
          res.on('data', (c) => errBody += c.toString('utf8'));
          res.on('end', () => reject(new Error(`runSession SSE HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)));
          return;
        }
        let buffer = '';
        let lastSession = null;
        res.on('data', (c) => {
          buffer += c.toString('utf8');
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const block of lines) {
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const evt = JSON.parse(dataLine.slice(6));
              if (evt?.session_id) lastSession = evt;
              if (typeof onEvent === 'function') onEvent(evt);
            } catch { /* ignore parse errors */ }
          }
        });
        res.on('end', () => resolve(lastSession || { stream_complete: true }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({ ...payload, stream: true }));
      req.end();
    });
  }

  async function pollSession(sessionId) {
    const r = await _http(
      'GET',
      `${ANTHROPIC_API_BASE}${AGENTS_BASE}/sessions/${encodeURIComponent(sessionId)}`,
      headers()
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`pollSession HTTP ${r.status}`);
    return r.body;
  }

  async function cancelSession(sessionId) {
    const r = await _http(
      'POST',
      `${ANTHROPIC_API_BASE}${AGENTS_BASE}/sessions/${encodeURIComponent(sessionId)}/cancel`,
      headers(),
      ''
    );
    if (r.status < 200 || r.status >= 300) throw new Error(`cancelSession HTTP ${r.status}`);
    return r.body;
  }

  return {
    ensureAgent,
    runSession,
    pollSession,
    cancelSession,
    constants: { MANAGED_AGENTS_BETA, AGENTS_BASE },
  };
}

module.exports = { createManagedAgentService, MANAGED_AGENTS_BETA };
