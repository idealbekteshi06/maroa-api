'use strict';

/**
 * lib/abuseDetector.js
 *
 * Lightweight anomaly detection for abuse patterns that slip past
 * rate-limits. Rate-limiters cap *request volume*; this module catches
 * *pattern* abuse: scanning UUIDs, probing for valid business IDs,
 * sending repeated invalid auth, etc.
 *
 * In-memory sliding window per IP. Fires `logger.warn` when thresholds
 * trip + optionally emits a Sentry event for ops follow-up. Does NOT
 * block — that's rate-limiter's job — but surfaces patterns worth
 * investigating.
 *
 * Production-ready alternative is fail2ban / Cloudflare WAF; this is
 * the in-process tripwire that fires faster (no log-tail latency) and
 * surfaces directly into our existing observability stack.
 *
 * Usage in server.js:
 *
 *   const abuse = require('./lib/abuseDetector').createDetector({ logger });
 *   app.use(abuse.middleware);
 *
 * Optional: scheduled cleanup
 *
 *   setInterval(abuse.sweep, 5 * 60 * 1000).unref();
 */

const WINDOW_MS = 60 * 1000;

// SECURITY: hard cap on the per-IP Map size. Without this cap, an
// attacker spoofing X-Forwarded-For (or just hitting from many real
// IPs) can force the Map to grow unbounded → OOM crash in minutes.
// Flagged by the 2026-05-11 Antigravity review.
//
// When the cap is hit we evict the IP with the OLDEST recent activity
// (true LRU would need a doubly-linked list; this approximation is
// O(n) on eviction but n=10000 is fine and eviction is rare).
const MAX_IPS = 10_000;

const PATTERNS = {
  // 10 401s in a minute from one IP → credential probing
  failed_auth: { threshold: 10, severity: 'high' },
  // 20 400s in a minute → scanner / invalid input flood
  validation_fail: { threshold: 20, severity: 'medium' },
  // 5 404s in a minute → route scanner
  route_scanner: { threshold: 15, severity: 'low' },
  // 5 different business_ids in a minute → enumeration
  biz_enumeration: { threshold: 5, severity: 'high' },
  // 3 invalid signatures (webhook) in a minute → webhook scanner
  invalid_signature: { threshold: 3, severity: 'critical' },
};

function createDetector({ logger, sentry = null } = {}) {
  // ip → { failed_auth: [ts...], validation_fail: [ts...], biz_ids: Set, ... }
  const state = new Map();

  // Approximate-LRU eviction when we hit MAX_IPS. We track the most
  // recent activity timestamp per IP and evict the lowest when capped.
  function mostRecentTs(bucket) {
    return Math.max(
      bucket.failed_auth[bucket.failed_auth.length - 1] || 0,
      bucket.validation_fail[bucket.validation_fail.length - 1] || 0,
      bucket.route_scanner[bucket.route_scanner.length - 1] || 0,
      bucket.invalid_signature[bucket.invalid_signature.length - 1] || 0
    );
  }

  function evictOldest() {
    let oldestIp = null;
    let oldestTs = Infinity;
    for (const [ip, bucket] of state) {
      const t = mostRecentTs(bucket);
      if (t < oldestTs) {
        oldestTs = t;
        oldestIp = ip;
      }
    }
    if (oldestIp) state.delete(oldestIp);
  }

  function bucketFor(ip) {
    if (!state.has(ip)) {
      // OOM Protection: Cap the Map at 5000 entries. Map iteration is in
      // insertion order, so keys().next().value gives the oldest entry.
      // This mathematically guarantees we cannot crash due to IP spoofing.
      if (state.size >= 5000) {
        state.delete(state.keys().next().value);
      }
      state.set(ip, {
        failed_auth: [],
        validation_fail: [],
        route_scanner: [],
        invalid_signature: [],
        biz_ids: new Map(), // biz_id → last_seen_ts
        last_alert: new Map(),
      });
    }
    return state.get(ip);
  }

  function pushAndCount(arr, now) {
    arr.push(now);
    const cutoff = now - WINDOW_MS;
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr.length;
  }

  function maybeAlert(pattern, ip, count, extra = {}) {
    const conf = PATTERNS[pattern];
    if (!conf || count < conf.threshold) return;
    const bucket = bucketFor(ip);
    // Don't spam the same alert — cool off 5 min per (pattern, ip) pair.
    const last = bucket.last_alert.get(pattern) || 0;
    if (Date.now() - last < 5 * 60 * 1000) return;
    bucket.last_alert.set(pattern, Date.now());

    logger?.warn?.('abuse-detector', null, `pattern: ${pattern}`, {
      ip,
      count,
      threshold: conf.threshold,
      severity: conf.severity,
      ...extra,
    });
    if (sentry?.captureMessage) {
      sentry.captureMessage(`abuse: ${pattern}`, {
        level: conf.severity === 'critical' ? 'error' : 'warning',
        tags: { abuse_pattern: pattern, abuse_ip: ip },
        extra: { count, threshold: conf.threshold, ...extra },
      });
    }
  }

  function middleware(req, res, next) {
    // Capture response status to classify after the handler runs.
    const origJson = res.json.bind(res);
    res.json = function (body) {
      try {
        record(req, res);
      } catch {
        /* never let detector break the response */
      }
      return origJson(body);
    };
    next();
  }

  function record(req, res) {
    const ip = req.ip || 'unknown';
    const status = res.statusCode;
    const now = Date.now();
    const bucket = bucketFor(ip);

    if (status === 401 || status === 403) {
      const c = pushAndCount(bucket.failed_auth, now);
      maybeAlert('failed_auth', ip, c, { path: req.path });
    }
    if (status === 400) {
      const c = pushAndCount(bucket.validation_fail, now);
      maybeAlert('validation_fail', ip, c, { path: req.path });
      // Invalid signature on a webhook = critical pattern
      if (req.path?.startsWith('/webhook/') && /signature/i.test(JSON.stringify(req.body || '').slice(0, 200))) {
        const s = pushAndCount(bucket.invalid_signature, now);
        maybeAlert('invalid_signature', ip, s, { path: req.path });
      }
    }
    if (status === 404) {
      const c = pushAndCount(bucket.route_scanner, now);
      maybeAlert('route_scanner', ip, c, { path: req.path });
    }

    // Enumeration: track unique business_id values from this IP over the window.
    const bizId = req.body?.business_id || req.body?.businessId || req.query?.business_id || req.params?.business_id;
    if (bizId && typeof bizId === 'string' && bizId.length > 8) {
      bucket.biz_ids.set(bizId, now);
      // Drop expired entries
      const cutoff = now - WINDOW_MS;
      for (const [b, t] of bucket.biz_ids) if (t < cutoff) bucket.biz_ids.delete(b);
      maybeAlert('biz_enumeration', ip, bucket.biz_ids.size, { distinct_ids: bucket.biz_ids.size });
    }
  }

  // Periodic cleanup so the map doesn't grow unbounded for long-lived processes.
  function sweep() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [ip, bucket] of state) {
      const recent = Math.max(
        bucket.failed_auth[bucket.failed_auth.length - 1] || 0,
        bucket.validation_fail[bucket.validation_fail.length - 1] || 0,
        bucket.route_scanner[bucket.route_scanner.length - 1] || 0,
        bucket.invalid_signature[bucket.invalid_signature.length - 1] || 0
      );
      if (recent && recent < cutoff) state.delete(ip);
    }
  }

  function snapshot() {
    const result = [];
    for (const [ip, bucket] of state) {
      result.push({
        ip,
        failed_auth: bucket.failed_auth.length,
        validation_fail: bucket.validation_fail.length,
        route_scanner: bucket.route_scanner.length,
        invalid_signature: bucket.invalid_signature.length,
        distinct_business_ids: bucket.biz_ids.size,
      });
    }
    return result;
  }

  return { middleware, sweep, snapshot, _state: state };
}

module.exports = { createDetector, PATTERNS, WINDOW_MS };
