#!/usr/bin/env node
/**
 * Local boot timing — time until GET /healthz returns 200.
 * Usage: PORT=8099 node scripts/measure-boot.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 8099;
const t0 = Date.now();
let listenMs = null;
let readyMs = null;

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    MAROA_ENV_SKIP_VALIDATION: '1',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (buf) => {
  const s = buf.toString();
  process.stdout.write(s);
  if (!listenMs && s.includes('[boot] listening')) listenMs = Date.now() - t0;
  if (!readyMs && s.includes('all routes registered')) readyMs = Date.now() - t0;
});

child.stderr.on('data', (buf) => process.stderr.write(buf));

async function probe() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/healthz`, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

for (let elapsed = 0; elapsed < 180_000; elapsed += 250) {
  await new Promise((r) => setTimeout(r, 250));
  const code = await probe();
  if (code === 200) {
    console.log(`\n[measure-boot] /healthz 200 at ${Date.now() - t0}ms`);
    break;
  }
}

if (listenMs != null) console.log(`[measure-boot] log: listening at ${listenMs}ms`);
if (readyMs != null) console.log(`[measure-boot] log: routes ready at ${readyMs}ms`);

child.kill('SIGTERM');
setTimeout(() => child.kill('SIGKILL'), 3000);
