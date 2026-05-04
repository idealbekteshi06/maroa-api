#!/usr/bin/env node
'use strict';

/**
 * mcp-server/server.js
 * ---------------------------------------------------------------------------
 * Maroa Internal Data MCP server.
 *
 * Implements the Model Context Protocol over stdio so any MCP-compatible
 * client (Claude Code, Cursor, Claude Desktop) can pull live business data
 * without copy-paste:
 *
 *   - get_business_profile(businessId)
 *   - get_content_history(businessId, limit, since?)
 *   - get_performance_metrics(businessId, range)
 *   - list_creative_concepts(businessId, limit)
 *   - list_recent_events(businessId, limit, kind?)
 *   - list_characters(businessId)
 *
 * Spec: https://modelcontextprotocol.io
 * Transport: stdio (JSON-RPC 2.0)
 * Auth: SUPABASE_KEY env (service role) — read-only for MCP usage.
 *
 * Run locally:
 *   node mcp-server/server.js
 *
 * Add to ~/.claude/mcp.json or Claude Desktop config:
 *   {
 *     "maroa-internal": {
 *       "command": "node",
 *       "args": ["/Users/.../Maroa.ai/mcp-server/server.js"],
 *       "env": {
 *         "SUPABASE_URL": "https://zqhyrbttuqkvmdewiytf.supabase.co",
 *         "SUPABASE_KEY": "<service-role-key>"
 *       }
 *     }
 *   }
 * ---------------------------------------------------------------------------
 */

const https = require('https');
const readline = require('readline');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://zqhyrbttuqkvmdewiytf.supabase.co').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

if (!SUPABASE_KEY) {
  process.stderr.write('[mcp-server] SUPABASE_KEY not set — cannot serve\n');
  process.exit(1);
}

function sbGet(table, query) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/rest/v1/${table}?${query}`);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Supabase timeout')));
    req.on('error', reject);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'get_business_profile',
    description: 'Fetch the full business + business_profile row for a given businessId. Returns brand DNA, tone, audience, location, plan, marketing goal, and any extended profile fields.',
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },
  {
    name: 'get_content_history',
    description: 'Return recent content_concepts + content_assets for a business, optionally filtered by status. Includes scores, captions, hashtags, posted_at when applicable.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        limit: { type: 'number', default: 30 },
        status: { type: 'string', description: 'optional: pending|approved|published|rejected' },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'get_performance_metrics',
    description: 'Return the latest daily_stats + content_performance rows for a business. Used to ground recommendations in real numbers.',
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
    description: 'Return Cannes-grade creative concepts produced by the creative-director engine, with insight, top_concept JSONB, weighted/humankind/grey scores, pattern, status, ab_variant.',
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
    description: 'Return rows from the unified events table for a business. Useful for debugging what fired and when across all workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        businessId: { type: 'string' },
        limit: { type: 'number', default: 50 },
        kind: { type: 'string', description: 'optional event kind filter (e.g. wf1.plan.created, vetter.enhance_via_higgsfield)' },
      },
      required: ['businessId'],
    },
  },
  {
    name: 'list_characters',
    description: 'Return Soul ID characters trained for this business, with training status + Higgsfield character id.',
    inputSchema: {
      type: 'object',
      properties: { businessId: { type: 'string' } },
      required: ['businessId'],
    },
  },
];

async function callTool(name, args) {
  const businessId = args?.businessId;
  if (!businessId && !['list_recent_events'].includes(name)) {
    throw new Error('businessId required');
  }

  switch (name) {
    case 'get_business_profile': {
      const [biz, profile] = await Promise.all([
        sbGet('businesses', `id=eq.${businessId}&select=*`),
        sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
      ]);
      return { business: biz?.[0] || null, profile: profile?.[0] || null };
    }
    case 'get_content_history': {
      const limit = Math.min(Number(args?.limit) || 30, 100);
      let q = `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=*`;
      if (args?.status) q += `&status=eq.${args.status}`;
      const [concepts, assets] = await Promise.all([
        sbGet('content_concepts', q),
        sbGet('content_assets', `business_id=eq.${businessId}&order=generated_at.desc&limit=${limit}&select=*`).catch(() => []),
      ]);
      return { concepts, assets };
    }
    case 'get_performance_metrics': {
      const days = Math.min(Number(args?.days) || 30, 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [daily, perf] = await Promise.all([
        sbGet('daily_stats', `business_id=eq.${businessId}&recorded_at=gte.${since}&order=recorded_at.desc&select=*`).catch(() => []),
        sbGet('content_performance', `business_id=eq.${businessId}&recorded_at=gte.${since}&order=recorded_at.desc&select=*`).catch(() => []),
      ]);
      return { daily_stats: daily, content_performance: perf };
    }
    case 'list_creative_concepts': {
      const limit = Math.min(Number(args?.limit) || 25, 100);
      const rows = await sbGet('creative_concepts', `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=id,content_goal,idea_level,insight,top_concept,weighted_score,humankind_score,grey_score,pattern,status,ab_variant,created_at`);
      return { concepts: rows };
    }
    case 'list_recent_events': {
      const limit = Math.min(Number(args?.limit) || 50, 200);
      let q = `${businessId ? `business_id=eq.${businessId}&` : ''}order=created_at.desc&limit=${limit}&select=*`;
      if (args?.kind) q += `&kind=eq.${args.kind}`;
      const rows = await sbGet('events', q);
      return { events: rows };
    }
    case 'list_characters': {
      const rows = await sbGet('business_characters', `business_id=eq.${businessId}&order=created_at.desc&select=id,name,character_type,training_status,higgsfield_character_id,source_image_count,is_default,created_at,trained_at`);
      return { characters: rows };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// JSON-RPC 2.0 over stdio
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
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req || {};

  try {
    if (method === 'initialize') {
      ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'maroa-internal', version: '1.0.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      ok(id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {});
      ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      return;
    }
    if (method === 'ping') { ok(id, {}); return; }
    err(id, -32601, `method not found: ${method}`);
  } catch (e) {
    err(id, -32000, e.message || 'internal error');
  }
});

process.stderr.write('[mcp-server] maroa-internal ready on stdio\n');
