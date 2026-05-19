#!/usr/bin/env node
'use strict';

/**
 * mcp-server/server.js
 * ---------------------------------------------------------------------------
 * Maroa MCP server — exposes Maroa's data + actions to any MCP-compatible
 * client (Claude Desktop, Claude Code, Cursor, etc.) over stdio (JSON-RPC).
 *
 * Two tool families:
 *
 *   READ tools (Supabase service-role, read-only):
 *     - get_business_profile
 *     - get_content_history
 *     - get_performance_metrics
 *     - list_creative_concepts
 *     - list_recent_events
 *     - list_characters
 *
 *   ACTION tools (Maroa API, requires MAROA_API_TOKEN):
 *     - list_workspaces
 *     - get_war_room          — full feed (clients, decisions, KPIs)
 *     - list_pending_approvals — only the things waiting on a human
 *     - approve_decision       — POST .../approve (idempotent)
 *     - reject_decision        — POST .../reject
 *     - get_brand_voice        — current tone + do/don't words
 *     - draft_post             — POST /api/content/generate (fire-and-forget)
 *     - cron_health            — when did each background job last run
 *
 * Spec: https://modelcontextprotocol.io
 *
 * Required env:
 *   SUPABASE_URL       — read-tools use this
 *   SUPABASE_KEY       — service-role key for read-tools
 *   MAROA_API_URL      — defaults to https://maroa-api-production.up.railway.app
 *   MAROA_API_TOKEN    — Bearer token issued from Maroa (per-user). Without
 *                        it, ACTION tools fail loudly; READ tools still work.
 *
 * Run locally:
 *   node mcp-server/server.js
 *
 * Add to ~/.claude/mcp.json or Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "maroa": {
 *         "command": "node",
 *         "args": ["/path/to/Maroa.ai/mcp-server/server.js"],
 *         "env": {
 *           "SUPABASE_URL": "...",
 *           "SUPABASE_KEY": "...",
 *           "MAROA_API_TOKEN": "..."
 *         }
 *       }
 *     }
 *   }
 * ---------------------------------------------------------------------------
 */

const https = require('https');
const readline = require('readline');

const clean = (v) => (v || '').replace(/[^\x20-\x7E]/g, '').trim();

const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_KEY = clean(process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
const MAROA_API_URL =
  clean(process.env.MAROA_API_URL) || 'https://maroa-api-production.up.railway.app';
const MAROA_API_TOKEN = clean(process.env.MAROA_API_TOKEN);

if (!SUPABASE_KEY) {
  process.stderr.write('[mcp-server] SUPABASE_KEY not set — READ tools disabled\n');
}
if (!MAROA_API_TOKEN) {
  process.stderr.write(
    '[mcp-server] MAROA_API_TOKEN not set — ACTION tools will fail with 401\n',
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function rawRequest(method, urlStr, headers, body, timeoutMs = 15000) {
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
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function sbGet(table, query) {
  if (!SUPABASE_KEY || !SUPABASE_URL) {
    return Promise.reject(new Error('Supabase not configured for MCP read tools'));
  }
  return rawRequest('GET', `${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }).then((r) => {
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`sbGet ${table}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    return Array.isArray(r.body) ? r.body : [];
  });
}

async function apiCall(method, path, body) {
  if (!MAROA_API_TOKEN) {
    throw new Error(
      'MAROA_API_TOKEN not set. Issue a token from Maroa and add it to the MCP server config.',
    );
  }
  const url = `${MAROA_API_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    Authorization: `Bearer ${MAROA_API_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // The MCP client never retries on its own, so the backend's
    // Idempotency-Key contract protects from accidental double-fire
    // when the user re-invokes the tool quickly.
    'Idempotency-Key': `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  const r = await rawRequest(method, url, headers, body, 25000);
  if (r.status >= 200 && r.status < 300) return r.body;
  const msg = (r.body && (r.body.error?.message || r.body.message)) || `${r.status}`;
  const err = new Error(`Maroa API ${method} ${path}: ${msg}`);
  err.status = r.status;
  throw err;
}

// ─── Tool definitions ────────────────────────────────────────────────────

const TOOLS = [
  // READ — direct Supabase
  {
    name: 'get_business_profile',
    description:
      'Fetch the full business + business_profile row for a businessId. Returns brand DNA, tone, audience, location, plan, marketing goal.',
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },
  {
    name: 'get_content_history',
    description:
      'Return recent content_concepts + content_assets for a business, optionally filtered by status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        limit: { type: 'number', default: 30 },
        status: { type: 'string', description: 'pending | approved | published | rejected' },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'get_performance_metrics',
    description: 'Return the latest daily_stats + content_performance rows for a business.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        days: { type: 'number', default: 30 },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'list_creative_concepts',
    description:
      'Return creative-director concepts with insight + top_concept JSONB + scoring + pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        limit: { type: 'number', default: 25 },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'list_recent_events',
    description:
      'Return rows from the unified events table. Useful for debugging what fired and when.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        limit: { type: 'number', default: 50 },
        kind: { type: 'string', description: 'optional event kind filter' },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'list_characters',
    description: 'Return Soul ID characters trained for this business.',
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },

  // ACTION — Maroa API
  {
    name: 'list_workspaces',
    description:
      'List workspaces the authenticated Maroa user is a member of. Returns id, name, plan_tier, role.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_war_room',
    description:
      'Fetch the full War Room feed (clients, decisions, creatives, KPI history, pending approvals) for a workspace.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
  },
  {
    name: 'list_pending_approvals',
    description:
      'List decisions across a workspace that are waiting for a human yes/no. One row per decision with the recommendation, confidence, and reasoning.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
  },
  {
    name: 'approve_decision',
    description:
      'Approve a pending decision. Idempotent — re-calling on an already-approved decision returns the same row. Triggers the side-effect immediately (content publishes, ad spend changes, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        decisionId: { type: 'string' },
      },
      required: ['workspaceId', 'decisionId'],
    },
  },
  {
    name: 'reject_decision',
    description:
      'Reject a pending decision with an optional one-line reason. Used to teach Maroa what NOT to do.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        decisionId: { type: 'string' },
        reason: { type: 'string', description: 'optional one-line reason' },
      },
      required: ['workspaceId', 'decisionId'],
    },
  },
  {
    name: 'get_brand_voice',
    description:
      "Return the current brand-voice anchor for a business: tone, do-use words, do-not-use words, customer phrases.",
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },
  {
    name: 'draft_post',
    description:
      'Ask Maroa to draft a new piece of content. Fire-and-forget — the draft lands in the approval inbox in a minute or two.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        theme: { type: 'string', description: 'optional creative direction' },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'cron_health',
    description:
      'Return when each background job (content generation, ad audit, competitor scan, etc.) last ran for a business.',
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },
];

// ─── Tool dispatch ───────────────────────────────────────────────────────

async function callTool(name, args) {
  args = args || {};
  const businessId = args.businessId;
  const workspaceId = args.workspaceId;

  switch (name) {
    // ── READ ────────────────────────────────────────────────────────
    case 'get_business_profile': {
      if (!businessId) throw new Error('businessId required');
      const [biz, profile] = await Promise.all([
        sbGet(
          'businesses',
          `id=eq.${encodeURIComponent(businessId)}&select=*`,
        ),
        sbGet(
          'business_profiles',
          `user_id=eq.${encodeURIComponent(businessId)}&select=*`,
        ).catch(() => []),
      ]);
      return { business: biz?.[0] || null, profile: profile?.[0] || null };
    }
    case 'get_content_history': {
      if (!businessId) throw new Error('businessId required');
      const limit = Math.min(Number(args.limit) || 30, 100);
      let q = `business_id=eq.${encodeURIComponent(businessId)}&order=created_at.desc&limit=${limit}&select=*`;
      if (args.status) q += `&status=eq.${encodeURIComponent(args.status)}`;
      const [concepts, assets] = await Promise.all([
        sbGet('content_concepts', q),
        sbGet(
          'content_assets',
          `business_id=eq.${encodeURIComponent(businessId)}&order=generated_at.desc&limit=${limit}&select=*`,
        ).catch(() => []),
      ]);
      return { concepts, assets };
    }
    case 'get_performance_metrics': {
      if (!businessId) throw new Error('businessId required');
      const days = Math.min(Number(args.days) || 30, 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [daily, perf] = await Promise.all([
        sbGet(
          'daily_stats',
          `business_id=eq.${encodeURIComponent(businessId)}&recorded_at=gte.${since}&order=recorded_at.desc&select=*`,
        ).catch(() => []),
        sbGet(
          'content_performance',
          `business_id=eq.${encodeURIComponent(businessId)}&recorded_at=gte.${since}&order=recorded_at.desc&select=*`,
        ).catch(() => []),
      ]);
      return { daily_stats: daily, content_performance: perf };
    }
    case 'list_creative_concepts': {
      if (!businessId) throw new Error('businessId required');
      const limit = Math.min(Number(args.limit) || 25, 100);
      const rows = await sbGet(
        'creative_concepts',
        `business_id=eq.${encodeURIComponent(businessId)}&order=created_at.desc&limit=${limit}&select=id,content_goal,idea_level,insight,top_concept,weighted_score,humankind_score,grey_score,pattern,status,ab_variant,created_at`,
      );
      return { concepts: rows };
    }
    case 'list_recent_events': {
      const limit = Math.min(Number(args.limit) || 50, 200);
      let q = `${businessId ? `business_id=eq.${encodeURIComponent(businessId)}&` : ''}order=created_at.desc&limit=${limit}&select=*`;
      if (args.kind) q += `&kind=eq.${encodeURIComponent(args.kind)}`;
      const rows = await sbGet('events', q);
      return { events: rows };
    }
    case 'list_characters': {
      if (!businessId) throw new Error('businessId required');
      const rows = await sbGet(
        'business_characters',
        `business_id=eq.${encodeURIComponent(businessId)}&order=created_at.desc&select=id,name,character_type,training_status,higgsfield_character_id,source_image_count,is_default,created_at,trained_at`,
      );
      return { characters: rows };
    }

    // ── ACTION ──────────────────────────────────────────────────────
    case 'list_workspaces':
      return apiCall('GET', '/api/workspaces');
    case 'get_war_room':
      if (!workspaceId) throw new Error('workspaceId required');
      return apiCall('GET', `/api/war-room/${encodeURIComponent(workspaceId)}`);
    case 'list_pending_approvals': {
      if (!workspaceId) throw new Error('workspaceId required');
      const feed = await apiCall('GET', `/api/war-room/${encodeURIComponent(workspaceId)}`);
      const pending = [];
      for (const c of feed?.clients || []) {
        for (const d of c.recent_decisions || []) {
          if (d.required_approval && !d.executed && !d.refused) {
            pending.push({
              decision_id: d.id,
              business_id: d.business_id,
              client_name: c.client?.client_name || null,
              agent: d.agent_name,
              recommendation: d.recommendation_text,
              confidence: d.confidence,
              expected_upside: d.expected_upside_text,
              created_at: d.created_at,
            });
          }
        }
      }
      return { workspaceId, count: pending.length, pending };
    }
    case 'approve_decision': {
      if (!workspaceId || !args.decisionId)
        throw new Error('workspaceId + decisionId required');
      return apiCall(
        'POST',
        `/api/war-room/${encodeURIComponent(workspaceId)}/decisions/${encodeURIComponent(args.decisionId)}/approve`,
        {},
      );
    }
    case 'reject_decision': {
      if (!workspaceId || !args.decisionId)
        throw new Error('workspaceId + decisionId required');
      return apiCall(
        'POST',
        `/api/war-room/${encodeURIComponent(workspaceId)}/decisions/${encodeURIComponent(args.decisionId)}/reject`,
        { reason: args.reason || null },
      );
    }
    case 'get_brand_voice': {
      if (!businessId) throw new Error('businessId required');
      return apiCall('GET', `/api/business/${encodeURIComponent(businessId)}/brand-voice`);
    }
    case 'draft_post': {
      if (!businessId) throw new Error('businessId required');
      return apiCall('POST', '/api/content/generate', {
        business_id: businessId,
        theme: args.theme,
      });
    }
    case 'cron_health': {
      if (!businessId) throw new Error('businessId required');
      return apiCall('GET', `/api/cron-health/${encodeURIComponent(businessId)}`);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ─── JSON-RPC over stdio ─────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}
function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function err(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req || {};

  try {
    if (method === 'initialize') {
      ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'maroa', version: '2.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      ok(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {});
      ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
      return;
    }
    if (method === 'ping') {
      ok(id, {});
      return;
    }
    err(id, -32601, `method not found: ${method}`);
  } catch (e) {
    err(id, -32000, e.message || 'internal error');
  }
});
