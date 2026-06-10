'use strict';

/**
 * lib/ssrfGuard.js — SSRF protection for server-side fetches of user-supplied
 * URLs (e.g. customer Zapier/Make webhook subscriptions).
 *
 * Blocks requests to private, loopback, link-local (incl. cloud metadata at
 * 169.254.169.254), CGNAT, and other non-public address ranges. Validates both
 * the literal hostname AND every DNS-resolved address, so a public hostname
 * that resolves into a private range is rejected too.
 *
 * Usage:
 *   const { assertPublicHttpUrl, SsrfBlocked } = require('./lib/ssrfGuard');
 *   await assertPublicHttpUrl(userUrl);   // throws SsrfBlocked on violation
 *
 * Re-validate at fire time (not just registration) to limit DNS-rebinding.
 */

const dns = require('dns').promises;
const net = require('net');

class SsrfBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlocked';
    this.code = 'SSRF_BLOCKED';
  }
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(ipInt, baseIp, bits) {
  const baseInt = ipv4ToInt(baseIp);
  if (baseInt == null || ipInt == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function isPrivateIpv4(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt == null) return true; // unparseable → treat as unsafe
  return BLOCKED_V4.some(([base, bits]) => inCidr4(ipInt, base, bits));
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase().split('%')[0]; // strip zone id
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  // IPv4-mapped/compatible, dotted form (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d)
  const embedded = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) return isPrivateIpv4(embedded[1]);
  // IPv4-mapped/compatible, HEX form (::ffff:7f00:1, ::ffff:a9fe:a9fe, ::7f00:1).
  // Without this, hex-encoded loopback/link-local (169.254.169.254 metadata)
  // slipped past the dotted-only check above and reached the network.
  const hexMapped = lower.match(/^::(?:ffff:)?(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIpv4(dotted);
  }
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true; // not a recognizable IP → unsafe
}

/**
 * Validate that urlString is an https URL whose host (literal + every resolved
 * address) is a public, routable address. Throws SsrfBlocked otherwise.
 * Returns the parsed URL on success.
 */
async function assertPublicHttpUrl(urlString, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new SsrfBlocked('webhook_url is not a valid URL');
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== 'https:' && !(allowHttp && scheme === 'http:')) {
    throw new SsrfBlocked('webhook_url must use https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');

  // Literal IP host → validate directly (no DNS).
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfBlocked('webhook_url points at a private or reserved address');
    return u;
  }

  // Hostname → resolve and validate every address (defeats DNS pointing at a
  // private range). Re-checked at fire time to limit rebinding.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new SsrfBlocked('webhook_url host could not be resolved');
  }
  if (!addrs.length) throw new SsrfBlocked('webhook_url host could not be resolved');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new SsrfBlocked('webhook_url resolves to a private or reserved address');
    }
  }
  return u;
}

module.exports = { assertPublicHttpUrl, isPrivateIp, SsrfBlocked };
