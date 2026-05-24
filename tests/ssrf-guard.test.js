'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIp, assertPublicHttpUrl, SsrfBlocked } = require('../lib/ssrfGuard');

test('isPrivateIp flags loopback, private, link-local, CGNAT, metadata', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ]) {
    assert.strictEqual(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('isPrivateIp allows public addresses', () => {
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(isPrivateIp('1.1.1.1'), false);
  assert.strictEqual(isPrivateIp('2606:4700:4700::1111'), false);
});

test('assertPublicHttpUrl rejects non-https', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://example.com'), SsrfBlocked);
  await assert.rejects(() => assertPublicHttpUrl('ftp://example.com'), SsrfBlocked);
  await assert.rejects(() => assertPublicHttpUrl('not-a-url'), SsrfBlocked);
});

test('assertPublicHttpUrl rejects literal private/metadata IPs without DNS', async () => {
  await assert.rejects(() => assertPublicHttpUrl('https://127.0.0.1/x'), SsrfBlocked);
  await assert.rejects(() => assertPublicHttpUrl('https://169.254.169.254/latest/meta-data/'), SsrfBlocked);
  await assert.rejects(() => assertPublicHttpUrl('https://[::1]/x'), SsrfBlocked);
  await assert.rejects(() => assertPublicHttpUrl('https://10.0.0.5/hook'), SsrfBlocked);
});

test('assertPublicHttpUrl accepts a public literal IP', async () => {
  const u = await assertPublicHttpUrl('https://8.8.8.8/hook');
  assert.strictEqual(u.hostname, '8.8.8.8');
});
