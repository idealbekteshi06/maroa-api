'use strict';

/**
 * lib/serviceTimeouts.js
 * ----------------------------------------------------------------------------
 * Per-service HTTP timeout map (in milliseconds).
 *
 * Why per-service: the global EXTERNAL_HTTP_TIMEOUT_MS (default 15s) is too
 * tight for Higgsfield image gen (normal 30-60s) and too generous for Paddle
 * checkout (should fast-fail under 10s so user retries themselves).
 *
 * Hostname matching is suffix-based on URL.hostname. The longest matching
 * suffix wins so 'api.anthropic.com' resolves before 'anthropic.com'.
 *
 * Adding a new service: append to TIMEOUTS_MS below. No code changes
 * elsewhere — apiRequestForHost(url) auto-picks.
 * ----------------------------------------------------------------------------
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.EXTERNAL_HTTP_TIMEOUT_MS) || 15_000;

const TIMEOUTS_MS = Object.freeze({
  'api.anthropic.com': 25_000,        // Sonnet/Opus can take 20s on long outputs
  'api.openai.com': 25_000,
  'api.higgsfield.io': 90_000,        // image/video generation: 30-60s normal
  'api.higgsfield.com': 90_000,
  'api.replicate.com': 60_000,        // image gen polls
  'graph.facebook.com': 15_000,       // Meta Graph v21
  'googleads.googleapis.com': 20_000, // Google Ads insights are heavy
  'api.paddle.com': 10_000,           // payments — fail fast, customer can retry
  'sandbox-api.paddle.com': 10_000,
  'serpapi.com': 15_000,
  'api.resend.com': 8_000,            // transactional email
  'api.upstash.com': 5_000,
  'app.ayrshare.com': 20_000,         // social multi-post
});

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function timeoutForHost(hostname) {
  if (!hostname) return DEFAULT_TIMEOUT_MS;
  if (TIMEOUTS_MS[hostname]) return TIMEOUTS_MS[hostname];
  // Suffix match (e.g., 'eu.api.openai.com' → 'api.openai.com')
  for (const key of Object.keys(TIMEOUTS_MS)) {
    if (hostname.endsWith('.' + key) || hostname === key) {
      return TIMEOUTS_MS[key];
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

function timeoutForUrl(url) {
  return timeoutForHost(hostnameFromUrl(url));
}

/**
 * Map URL hostname → breaker name in lib/breakers.js. Lets us auto-route
 * through the right circuit breaker without each call site naming it.
 */
const BREAKER_BY_HOST = Object.freeze({
  'api.anthropic.com': 'anthropic',
  'graph.facebook.com': 'meta-marketing',
  'googleads.googleapis.com': 'google-ads',
  'api.higgsfield.io': 'higgsfield',
  'api.higgsfield.com': 'higgsfield',
  'api.paddle.com': 'paddle',
  'sandbox-api.paddle.com': 'paddle',
  'serpapi.com': 'serpapi',
  'api.replicate.com': 'replicate',
});

function breakerForHost(hostname) {
  if (!hostname) return null;
  if (BREAKER_BY_HOST[hostname]) return BREAKER_BY_HOST[hostname];
  for (const key of Object.keys(BREAKER_BY_HOST)) {
    if (hostname.endsWith('.' + key) || hostname === key) {
      return BREAKER_BY_HOST[key];
    }
  }
  return null;
}

function breakerForUrl(url) {
  return breakerForHost(hostnameFromUrl(url));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  TIMEOUTS_MS,
  timeoutForHost,
  timeoutForUrl,
  BREAKER_BY_HOST,
  breakerForHost,
  breakerForUrl,
};
