#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

/**
 * @maroa/cli — npx maroa
 * ----------------------------------------------------------------------------
 * Distribution wedge: run Maroa from the terminal. Power-user freelancers
 * + agency operators live in iTerm/Warp and would rather hit `maroa pending`
 * than open the browser.
 *
 * Subcommands:
 *
 *   maroa setup                     interactive — store API URL + token
 *   maroa status                    one-line workspace summary
 *   maroa pending                   list things waiting on approval
 *   maroa approve <decision-id>     approve a decision
 *   maroa reject  <decision-id> [reason]
 *   maroa draft   "theme"           ask Maroa to draft a new piece
 *   maroa whoami                    show configured account
 *   maroa logout                    clear stored credentials
 *
 * Config lives at ~/.maroa/config.json (chmod 600). Token = Supabase JWT
 * the user pastes from the dashboard or that the magic-link CLI flow
 * captures (future).
 *
 * No external dependencies — uses node:https + node:readline so `npx maroa`
 * is a single fast install.
 * ----------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');
const https = require('node:https');
const http = require('node:http');

const CONFIG_DIR = path.join(os.homedir(), '.maroa');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_API = 'https://maroa-api-production.up.railway.app';

function color(c, s) {
  if (!process.stdout.isTTY) return s;
  const codes = { dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, bold: 1, gray: 90 };
  const code = codes[c] || 0;
  return `[${code}m${s}[0m`;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function api(method, pathSuffix, body) {
  const cfg = loadConfig();
  const base = cfg.api_url || DEFAULT_API;
  if (!cfg.token) {
    return Promise.reject(new Error('Not configured. Run `maroa setup` first.'));
  }
  const url = new URL(`${base.replace(/\/$/, '')}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`);
  const lib = url.protocol === 'https:' ? https : http;
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': '@maroa/cli',
          'Idempotency-Key': `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        },
      },
      (res) => {
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
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            return resolve(parsed);
          }
          const msg = (parsed && (parsed.error?.message || parsed.message)) || `${res.statusCode}`;
          const err = new Error(`API ${method} ${pathSuffix}: ${msg}`);
          err.status = res.statusCode;
          reject(err);
        });
      }
    );
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Commands ───────────────────────────────────────────────────────────

async function cmdSetup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(color('bold', '\n🔧 Maroa CLI setup\n'));
  console.log('Get your token from: ' + color('cyan', 'https://maroa.ai/settings → API tokens'));
  console.log('Press Ctrl-C any time to abort.\n');
  const apiUrl = (await rl.question(`API URL [${DEFAULT_API}]: `)).trim() || DEFAULT_API;
  const token = (await rl.question('Token: ')).trim();
  if (!token) {
    console.error(color('red', 'No token entered — aborting.'));
    rl.close();
    process.exit(1);
  }
  saveConfig({ api_url: apiUrl, token, configured_at: new Date().toISOString() });
  console.log(color('green', `\n✓ Saved to ${CONFIG_PATH} (chmod 600)`));
  rl.close();
  // Smoke-test: hit /api/workspaces
  try {
    const r = await api('GET', '/api/workspaces');
    const count = (r?.workspaces || []).length;
    console.log(color('green', `✓ Authenticated. ${count} workspace${count === 1 ? '' : 's'} reachable.`));
  } catch (e) {
    console.error(color('yellow', `⚠ Auth check failed: ${e.message}`));
  }
}

async function cmdWhoami() {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.log(color('yellow', 'Not configured. Run `maroa setup`.'));
    return;
  }
  console.log(`API: ${color('cyan', cfg.api_url || DEFAULT_API)}`);
  console.log(`Token: ${color('dim', cfg.token.slice(0, 12) + '…')}`);
  console.log(`Configured: ${color('dim', cfg.configured_at || 'unknown')}`);
  try {
    const r = await api('GET', '/api/workspaces');
    const ws = r?.workspaces || [];
    console.log(`Workspaces:`);
    if (ws.length === 0) {
      console.log(color('dim', '  (none)'));
    }
    for (const w of ws) {
      console.log(`  • ${w.name} (${w.plan_tier || 'unknown'}) — ${w.id}`);
    }
  } catch (e) {
    console.error(color('red', `Could not list workspaces: ${e.message}`));
  }
}

async function cmdLogout() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
    console.log(color('green', '✓ Logged out.'));
  } else {
    console.log(color('dim', 'Already logged out.'));
  }
}

async function pickWorkspaceId() {
  const r = await api('GET', '/api/workspaces');
  const ws = r?.workspaces || [];
  if (ws.length === 0) {
    throw new Error('No workspaces accessible. Have an owner invite you.');
  }
  return ws[0].id;
}

async function cmdStatus() {
  const wsId = await pickWorkspaceId();
  const feed = await api('GET', `/api/war-room/${encodeURIComponent(wsId)}`);
  const pending = (feed?.clients || [])
    .flatMap((c) => c.recent_decisions || [])
    .filter((d) => d.required_approval && !d.executed && !d.refused).length;
  const live = feed?.summary?.creatives_total || 0;
  const decaying = feed?.summary?.decaying_or_dead || 0;
  if (pending > 0) {
    console.log(
      color('yellow', `${pending} ${pending === 1 ? 'thing needs' : 'things need'} your eyes`) +
        color('dim', `  ·  ${live} live  ·  ${decaying} fading`)
    );
    console.log(color('dim', `Run \`maroa pending\` to triage.`));
  } else {
    console.log(color('green', '✓ Inbox clear') + color('dim', `  ·  ${live} live  ·  ${decaying} fading`));
  }
}

async function cmdPending() {
  const wsId = await pickWorkspaceId();
  const feed = await api('GET', `/api/war-room/${encodeURIComponent(wsId)}`);
  const rows = (feed?.clients || [])
    .flatMap((c) => (c.recent_decisions || []).map((d) => ({ ...d, _client: c })))
    .filter((d) => d.required_approval && !d.executed && !d.refused);
  if (rows.length === 0) {
    console.log(color('green', '✓ Inbox clear.'));
    return;
  }
  console.log(color('bold', `${rows.length} pending\n`));
  for (const d of rows.slice(0, 20)) {
    const client = d._client?.client?.client_name || 'business';
    const conf =
      typeof d.confidence === 'number' && d.confidence > 0
        ? `  ${color('dim', `(${Math.round(d.confidence * 100)}% sure)`)}`
        : '';
    console.log(`${color('cyan', d.id)}  ${color('dim', `[${client} · ${d.agent_name}]`)}`);
    console.log(`  ${(d.recommendation_text || '').slice(0, 200)}${conf}`);
    console.log('');
  }
  console.log(color('dim', '→ Approve with `maroa approve <id>` or reject with `maroa reject <id> <reason>`'));
}

async function cmdApprove(args) {
  const id = args[0];
  if (!id) {
    console.error(color('red', 'Usage: maroa approve <decision-id>'));
    process.exit(2);
  }
  const wsId = await pickWorkspaceId();
  await api('POST', `/api/war-room/${encodeURIComponent(wsId)}/decisions/${encodeURIComponent(id)}/approve`, {});
  console.log(color('green', '✓ Approved. Maroa is shipping it now.'));
}

async function cmdReject(args) {
  const id = args[0];
  if (!id) {
    console.error(color('red', 'Usage: maroa reject <decision-id> [reason]'));
    process.exit(2);
  }
  const reason = args.slice(1).join(' ').trim() || null;
  const wsId = await pickWorkspaceId();
  await api('POST', `/api/war-room/${encodeURIComponent(wsId)}/decisions/${encodeURIComponent(id)}/reject`, { reason });
  console.log(color('yellow', '✗ Rejected.'));
}

async function cmdDraft(args) {
  const theme = args.join(' ').trim();
  if (!theme) {
    console.error(color('red', 'Usage: maroa draft "theme — e.g. Friday lunch special"'));
    process.exit(2);
  }
  const wsId = await pickWorkspaceId();
  const feed = await api('GET', `/api/war-room/${encodeURIComponent(wsId)}`);
  const businessId = feed?.clients?.[0]?.business_id;
  if (!businessId) {
    console.error(color('red', 'No business in this workspace to draft for.'));
    process.exit(2);
  }
  await api('POST', '/api/content/generate', { business_id: businessId, theme });
  console.log(color('green', '✓ Drafting now. Run `maroa pending` in a minute or two.'));
}

function help() {
  console.log(`
${color('bold', 'Maroa CLI')}  ${color('dim', '— run Maroa.ai from your terminal')}

${color('bold', 'Commands')}
  ${color('cyan', 'maroa setup')}                  configure API + token
  ${color('cyan', 'maroa status')}                 one-line workspace summary
  ${color('cyan', 'maroa pending')}                list things waiting for approval
  ${color('cyan', 'maroa approve <id>')}           approve a decision
  ${color('cyan', 'maroa reject <id> [reason]')}   reject a decision
  ${color('cyan', 'maroa draft "theme"')}          ask Maroa to draft new content
  ${color('cyan', 'maroa whoami')}                 show configured account
  ${color('cyan', 'maroa logout')}                 clear stored credentials

${color('dim', 'Config:')} ${color('dim', CONFIG_PATH)}
${color('dim', 'Docs:')}   ${color('dim', 'https://docs.maroa.ai/cli')}
`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    switch ((cmd || 'help').toLowerCase()) {
      case 'setup':
        return cmdSetup();
      case 'status':
        return cmdStatus();
      case 'pending':
      case 'approvals':
        return cmdPending();
      case 'approve':
        return cmdApprove(args);
      case 'reject':
        return cmdReject(args);
      case 'draft':
        return cmdDraft(args);
      case 'whoami':
        return cmdWhoami();
      case 'logout':
        return cmdLogout();
      case 'help':
      case '--help':
      case '-h':
        return help();
      default:
        console.error(color('red', `Unknown command: ${cmd}`));
        help();
        process.exit(2);
    }
  } catch (e) {
    console.error(color('red', `Error: ${e.message}`));
    if (e.status === 401) {
      console.error(color('dim', 'Token might be expired. Run `maroa setup` to refresh.'));
    }
    process.exit(1);
  }
}

main();
