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

## Verify after deploy

```bash
curl -sS "https://maroa-api-production.up.railway.app/healthz"
curl -sS "https://maroa-api-production.up.railway.app/readyz" | head -c 500
```

Logs should show:

- `[boot] listening — registering routes (/healthz live)` early
- `[boot] all routes registered — server fully ready` after route load
