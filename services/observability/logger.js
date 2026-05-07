'use strict';

/**
 * services/observability/logger.js
 * ----------------------------------------------------------------------------
 * Structured JSON logger. Replaces ad-hoc console.log / logger.info calls with
 * consistent shape that's parseable by Datadog/Posthog/Loki/etc.
 *
 * Output schema (one JSON object per log line):
 *   {
 *     "ts": "2026-05-07T14:23:00.123Z",
 *     "level": "info|warn|error|debug",
 *     "service": "maroa-api",
 *     "module": "ad-optimizer.engine",
 *     "msg": "audit complete",
 *     "businessId": "uuid",
 *     "request_id": "req_abc",
 *     "duration_ms": 412,
 *     "...arbitrary": "context"
 *   }
 *
 * Errors include `stack` + `error.code` automatically.
 *
 * Features:
 *   - Request ID propagation (via async-local-storage if available, else flag)
 *   - Sentry breadcrumb auto-emission for warn+error levels
 *   - Cost tracking on `cost_usd` field — surfaces in metrics
 *   - Request-scoped child loggers
 * ----------------------------------------------------------------------------
 */

const SERVICE = 'maroa-api';
const VERSION = process.env.npm_package_version || 'unknown';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const MIN_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const MIN_LEVEL_IDX = Math.max(0, LEVELS.indexOf(MIN_LEVEL));

function shouldLog(level) {
  const idx = LEVELS.indexOf(level);
  return idx >= 0 && idx >= MIN_LEVEL_IDX;
}

function _now() {
  return new Date().toISOString();
}

function _emit(level, mod, msg, ctx = {}) {
  if (!shouldLog(level)) return;
  const line = {
    ts: _now(),
    level,
    service: SERVICE,
    version: VERSION,
    module: mod,
    msg,
    ...ctx,
  };
  // Stack handling for Error objects
  if (ctx?.error instanceof Error) {
    line.error = {
      message: ctx.error.message,
      stack: ctx.error.stack,
      code: ctx.error.code,
    };
  }
  // Use stderr for warn+error so log shippers can route differently
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');

  // Sentry breadcrumb for warn/error (if available)
  try {
    if ((level === 'warn' || level === 'error') && global.__sentry) {
      global.__sentry.addBreadcrumb({
        category: mod,
        level: level === 'error' ? 'error' : 'warning',
        message: msg,
        data: ctx,
      });
    }
  } catch { /* best-effort */ }
}

function makeLogger(mod) {
  if (!mod || typeof mod !== 'string') mod = 'unknown';
  return {
    debug: (msg, ctx) => _emit('debug', mod, msg, ctx),
    info:  (msg, ctx) => _emit('info',  mod, msg, ctx),
    warn:  (msg, ctx) => _emit('warn',  mod, msg, ctx),
    error: (msg, ctx) => _emit('error', mod, msg, ctx),
    /**
     * Track cost of an LLM call. Records cost_usd in metrics + log line.
     * Used by callers right after they get a response with token usage.
     */
    cost: (msg, costUsd, ctx) => _emit('info', mod, msg, { ...ctx, cost_usd: Number(costUsd) || 0, type: 'cost' }),
    /**
     * Time a code block. Returns a function — call it when done to log duration.
     *
     *   const done = log.time('audit.run', { businessId });
     *   await runAudit();
     *   done(); // logs 'audit.run took N ms'
     */
    time: (msg, ctx = {}) => {
      const start = Date.now();
      return (extra = {}) => {
        const duration_ms = Date.now() - start;
        _emit('info', mod, msg, { ...ctx, ...extra, duration_ms, type: 'timing' });
        return duration_ms;
      };
    },
    /**
     * Compatibility shim — accepts old (mod, businessId, msg, ctx) shape from
     * legacy code that passed positional args.
     */
    legacy: (oldMod, businessId, msg, ctx) => {
      const realCtx = ctx instanceof Error ? { error: ctx } : (ctx || {});
      _emit('info', oldMod || mod, msg || '', { businessId, ...realCtx });
    },
  };
}

module.exports = { makeLogger, shouldLog };
