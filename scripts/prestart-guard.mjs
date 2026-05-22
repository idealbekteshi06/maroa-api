#!/usr/bin/env node
/**
 * prestart-guard.mjs — npm lifecycle hook before `npm start`.
 *
 * Railway production should use `node server.js` (see railway.toml startCommand)
 * so this script never runs there. If the dashboard still uses `npm start`,
 * skip sync_foundation on Railway — committed services/prompts/*.js are canonical.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const onRailway =
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_REPLICA_ID;

if (onRailway) {
  console.log('[prestart] Railway detected — skipping sync_foundation (startCommand should be node server.js)');
  process.exit(0);
}

const r = spawnSync(process.execPath, [join(root, 'scripts/sync_foundation.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(r.status ?? 1);
