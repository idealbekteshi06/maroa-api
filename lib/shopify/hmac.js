'use strict';

/**
 * lib/shopify/hmac.js — Shopify signature verification (two distinct schemes).
 *
 * Shopify signs two different things two different ways:
 *
 *   1. WEBHOOKS: HMAC-SHA256 of the RAW request body, base64-encoded, in the
 *      `X-Shopify-Hmac-Sha256` header. Verified against the raw bytes — NOT
 *      the parsed JSON (re-serializing changes whitespace/key-order and breaks
 *      the hash). Mirrors services/stripe + services/paddle which also hash the
 *      raw Buffer. There is NO signed timestamp on Shopify webhooks, so replay
 *      protection comes from idempotency on the X-Shopify-Webhook-Id header
 *      (lib/webhookEvents), not a time window.
 *
 *   2. OAUTH redirects (install/callback): HMAC-SHA256 of the sorted,
 *      url-escaped query params (minus `hmac`/`signature`), hex-encoded, in the
 *      `hmac` query param. Confirms the redirect genuinely came from Shopify.
 *
 * Both use the app's API secret (SHOPIFY_API_SECRET) as the key and a
 * constant-time compare so a wrong signature can't be discovered byte-by-byte.
 */

const crypto = require('crypto');

/**
 * Verify a Shopify webhook signature against the raw request body.
 *
 * @param {Buffer|string} rawBody         The exact bytes Shopify POSTed.
 * @param {string}        headerHmacB64   X-Shopify-Hmac-Sha256 header (base64).
 * @param {string}        secret          App API secret (SHOPIFY_API_SECRET).
 * @returns {boolean}
 */
function verifyWebhookHmac(rawBody, headerHmacB64, secret) {
  if (!secret || !headerHmacB64 || rawBody === null || rawBody === undefined) return false;
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(buf).digest(); // raw bytes
  let provided;
  try {
    provided = Buffer.from(String(headerHmacB64), 'base64');
  } catch {
    return false;
  }
  if (provided.length !== digest.length) return false;
  try {
    return crypto.timingSafeEqual(provided, digest);
  } catch {
    return false;
  }
}

// Shopify's documented escaping for the OAuth HMAC message: in keys and values
// `&` → `%26` and `%` → `%25`; in keys additionally `=` → `%3D`. Applied before
// joining so a value containing `&` can't be used to forge a different param.
function escapeValue(v) {
  return String(v).replace(/%/g, '%25').replace(/&/g, '%26');
}
function escapeKey(k) {
  return String(k).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
}

/**
 * Verify the `hmac` query param on a Shopify OAuth install/callback redirect.
 *
 * @param {object} query   Parsed query params (req.query). Must include `hmac`.
 * @param {string} secret  App API secret (SHOPIFY_API_SECRET).
 * @returns {boolean}
 */
function verifyQueryHmac(query, secret) {
  if (!query || !secret) return false;
  const provided = query.hmac;
  if (!provided || typeof provided !== 'string') return false;

  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => {
      const raw = query[k];
      const value = Array.isArray(raw) ? raw.join(',') : raw;
      return `${escapeKey(k)}=${escapeValue(value)}`;
    })
    .join('&');

  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Shop-domain validation — guards every place a `shop` value becomes part of a
// URL we call or store. Blocks SSRF / open-redirect via a crafted shop param.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
function isValidShopDomain(shop) {
  return typeof shop === 'string' && shop.length <= 100 && SHOP_DOMAIN_RE.test(shop);
}

module.exports = { verifyWebhookHmac, verifyQueryHmac, isValidShopDomain };
