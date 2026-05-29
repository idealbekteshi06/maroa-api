'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { enrichFromWebsite, normalizeUrl, isBlockedHost, htmlToText } = require('../lib/websiteEnricher');

const extractJSON = (raw) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
};

test('normalizeUrl: adds https, accepts public hosts, rejects junk', () => {
  assert.strictEqual(normalizeUrl('example.com'), 'https://example.com/');
  assert.strictEqual(normalizeUrl('https://shop.example.com/x'), 'https://shop.example.com/x');
  assert.strictEqual(normalizeUrl(''), null);
  assert.strictEqual(normalizeUrl('not a url with spaces'), null);
  assert.strictEqual(normalizeUrl('ftp://example.com'), null, 'non-http(s) rejected');
});

test('isBlockedHost: blocks SSRF targets', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
    assert.strictEqual(isBlockedHost(h), true, `${h} should be blocked`);
  }
  assert.strictEqual(isBlockedHost('example.com'), false);
  assert.strictEqual(isBlockedHost('8.8.8.8'), false);
});

test('normalizeUrl: refuses internal/metadata hosts (SSRF)', () => {
  assert.strictEqual(normalizeUrl('http://169.254.169.254/latest/meta-data/'), null);
  assert.strictEqual(normalizeUrl('http://localhost:3000/admin'), null);
  assert.strictEqual(normalizeUrl('https://10.0.0.1/'), null);
});

test('htmlToText: strips tags, scripts, styles; collapses whitespace', () => {
  const html =
    '<html><head><style>.a{color:red}</style><script>evil()</script></head><body><h1>Joe&#39;s Cafe</h1><p>Best  coffee</p></body></html>';
  const text = htmlToText(html);
  assert.ok(!/script|style|<h1>/.test(text), 'no tags or script/style content');
  assert.match(text, /Joe's Cafe/);
  assert.match(text, /Best coffee/);
});

test('enrichFromWebsite: happy path returns structured summary', async () => {
  const deps = {
    fetchImpl: async () => ({
      ok: true,
      text: async () =>
        '<html><body><h1>Joe Coffee</h1><p>Specialty espresso bar in Austin. We roast our own beans and serve pastries.</p></body></html>',
    }),
    callClaude: async () =>
      JSON.stringify({
        business_description: 'Specialty espresso bar in Austin roasting its own beans.',
        products_services: ['espresso', 'pastries', 'house-roasted beans'],
        differentiator: 'in-house roasting',
        tone: 'warm, local, craft',
        summary: 'Joe Coffee is an Austin specialty espresso bar with house-roasted beans and fresh pastries.',
      }),
    extractJSON,
    logger: { warn() {} },
  };
  const r = await enrichFromWebsite({ url: 'joecoffee.com', deps, businessId: 'b1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://joecoffee.com/');
  assert.match(r.summary, /Joe Coffee/);
  assert.deepStrictEqual(r.structured.products_services.includes('espresso'), true);
  assert.strictEqual(r.structured.tone, 'warm, local, craft');
});

test('enrichFromWebsite: refuses blocked/invalid URL before any fetch', async () => {
  let fetched = false;
  const r = await enrichFromWebsite({
    url: 'http://169.254.169.254/',
    deps: {
      fetchImpl: async () => {
        fetched = true;
        return { ok: true, text: async () => '' };
      },
      callClaude: async () => '{}',
      extractJSON,
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_or_blocked_url');
  assert.strictEqual(fetched, false, 'must not fetch a blocked host');
});

test('enrichFromWebsite: non-200 response → ok:false', async () => {
  const r = await enrichFromWebsite({
    url: 'example.com',
    deps: {
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
      callClaude: async () => '{}',
      extractJSON,
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'http_404');
});

test('enrichFromWebsite: thin content → ok:false (no model call)', async () => {
  let called = false;
  const r = await enrichFromWebsite({
    url: 'example.com',
    deps: {
      fetchImpl: async () => ({ ok: true, text: async () => '<html><body>hi</body></html>' }),
      callClaude: async () => {
        called = true;
        return '{}';
      },
      extractJSON,
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too_little_content');
  assert.strictEqual(called, false);
});

test('enrichFromWebsite: fetch throw → ok:false, does not propagate', async () => {
  const r = await enrichFromWebsite({
    url: 'example.com',
    deps: {
      fetchImpl: async () => {
        throw new Error('ETIMEDOUT');
      },
      callClaude: async () => '{}',
      extractJSON,
      logger: { warn() {} },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'fetch_failed');
});
