# Railway deploy — healthcheck

## Why deploys fail at ~4m53s

Railway’s **default** healthcheck timeout is **300 seconds** (~5 minutes). If `railway.toml` / `railway.json` are not loaded for this service, you will always hit that cap even when the app would become healthy seconds later.

The monolith takes **1–3 minutes** after the process starts before `app.listen()` ran historically; early listen now exposes `/healthz` within seconds (see `server.js` after metrics middleware).

## Required: config file at service root

1. In **Railway → Service → Settings → Source**, set **Root Directory** to the repo root (empty or `.`), **not** a subfolder, unless you set **Config file path** to the real path (e.g. `/railway.toml`).
2. Commit includes **`railway.toml`** and **`railway.json`** at repo root with `healthcheckPath = "/healthz"` and `healthcheckTimeout = 600`.
3. On a deploy’s **Details** page, hover the healthcheck setting — a **file icon** means config-as-code was applied.

## Required: increase timeout via service variable

Railway documents `healthcheckTimeout` in config-as-code **and** this variable:

| Variable | Value | Purpose |
|----------|-------|---------|
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `600` | Platform healthcheck wait (seconds) |

Add it under **Railway → Variables** for `maroa-api-production`. This works even when TOML is ignored.

## Start command

Config uses `startCommand = "node server.js"` (not `npm start`) so **`prestart` / `sync_foundation` does not run on every deploy** — generated prompts are already committed under `services/prompts/`.

## Healthcheck hostname

Probes use host **`healthcheck.railway.app`**. Do not add middleware that rejects that Host header.

## Startup timing (local measurements)

| Step | Time |
|------|------|
| `node scripts/sync_foundation.mjs` | **~0.3s** (no-op on Railway when frontend sibling repo absent) |
| `npm start` prestart on Railway | **skipped** when `startCommand = node server.js` |
| `/healthz` live (early listen) | **&lt;1s** after process start |
| Deferred route table (`setImmediate`) | **~0.2–0.6s** on dev hardware |

The 9+ minute Railway failures were **not** prestart — they were the **~10k-line synchronous `server.js` load** blocking the event loop before `/healthz` could respond. Fix: early `listen()` + `setImmediate` for route registration.

## Verify after deploy

```bash
curl -sS "https://maroa-api-production.up.railway.app/healthz"
curl -sS "https://maroa-api-production.up.railway.app/readyz" | head -c 500
```

Logs should show:

- `[boot] listening — loading routes (/healthz ready)` within seconds of container start
- `[boot] all routes registered — server fully ready { duration_ms: ... }` shortly after
