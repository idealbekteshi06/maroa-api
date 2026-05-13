'use strict';

/**
 * lib/internalDispatcher.js
 * ---------------------------------------------------------------------------
 * In-process dispatcher for Inngest → Express handlers.
 *
 * Problem (called out in 2026-05-12 review, scoring Architecture 8.5/10):
 *   Every Inngest scheduled function in services/inngest/functions.js does
 *   an HTTP POST to a webhook endpoint on the SAME Node process. Under
 *   nightly cron load (hundreds of jobs) this:
 *     - exhausts ephemeral TCP ports (mitigated by keep-alive agent in
 *       Wave 49, but the design is still wrong)
 *     - pays JSON serialize → TCP → JSON deserialize round-trip cost
 *     - has its own timeouts + retries layered on top of Inngest's
 *
 * Fix:
 *   Same-process invocations call the handler directly. Cross-process
 *   (when Inngest is on a different machine, or for staging redirects)
 *   keeps using HTTP loopback. The two paths are 1:1 equivalent — the
 *   handler signature is identical to an Express webhook handler.
 *
 * Migration strategy:
 *   Incremental. Routes register themselves with the dispatcher as they
 *   are migrated. Routes that haven't migrated still respond to HTTP
 *   only — backwards compatible. Inngest's callInternal tries the
 *   dispatcher first, falls back to HTTP if the path isn't registered.
 *
 * Public API:
 *
 *   const dispatcher = require('./lib/internalDispatcher');
 *
 *   // From routes — register a path + handler:
 *   dispatcher.register('/webhook/ad-optimizer-daily-audit', async (body) => {
 *     ... business logic ...
 *     return { ok: true, audited: 42 };
 *   });
 *
 *   // From Inngest — dispatch (returns null if not registered, falls
 *   // back to HTTP loopback):
 *   const result = await dispatcher.dispatch('/webhook/...', body);
 *
 * Failure modes:
 *   - Handler throws         → caller sees the throw (same as HTTP)
 *   - Path not registered    → dispatch returns { _notRegistered: true }
 *                              so caller falls back to HTTP
 *   - Handler hangs          → caller is responsible for timeout
 *                              (Inngest already has its own step timeout)
 *
 * Telemetry:
 *   dispatcher.snapshot() → { registered: [...paths], hits: count, misses: count }
 * ---------------------------------------------------------------------------
 */

const _handlers = new Map();
let _hits = 0;
let _misses = 0;

/**
 * Register a handler for a given internal path. The handler signature is
 * `async (body, meta) => result`. `meta` carries headers + the original
 * Inngest event metadata (when relevant).
 *
 * Registering the same path twice replaces the prior handler. This is
 * intentional — it lets the Express route REGISTER first, and then a
 * test stub OVERWRITE for unit testing.
 */
function register(path, handler) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('internalDispatcher.register: path must start with /');
  }
  if (typeof handler !== 'function') {
    throw new Error('internalDispatcher.register: handler must be a function');
  }
  _handlers.set(path, handler);
}

function unregister(path) {
  return _handlers.delete(path);
}

/**
 * Try to dispatch in-process. Returns:
 *   - the handler's resolved value (any shape) on success
 *   - { _notRegistered: true } if no handler for the path
 *
 * Caller (Inngest functions.js) uses _notRegistered as the signal to
 * fall back to HTTP loopback.
 */
async function dispatch(path, body, meta = {}) {
  const handler = _handlers.get(path);
  if (!handler) {
    _misses++;
    return { _notRegistered: true };
  }
  _hits++;
  return await handler(body, meta);
}

function isRegistered(path) {
  return _handlers.has(path);
}

function snapshot() {
  return {
    registered: [..._handlers.keys()].sort(),
    hits: _hits,
    misses: _misses,
  };
}

/**
 * Test-only: wipe the registry. Production should never call this.
 */
function _reset() {
  _handlers.clear();
  _hits = 0;
  _misses = 0;
}

module.exports = {
  register,
  unregister,
  dispatch,
  isRegistered,
  snapshot,
  _reset,
};
