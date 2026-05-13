'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { securityHeaders, DEFAULT_HEADERS_PROD, DEFAULT_HEADERS_DEV, CSP_PROFILES } = require('../lib/securityHeaders');

function makeFakeReqRes() {
  const headers = {};
  const locals = {};
  const res = {
    locals,
    setHeader(k, v) {
      headers[k] = v;
    },
    getHeader(k) {
      return headers[k];
    },
    _ended: false,
    _endArgs: null,
    end(...args) {
      this._ended = true;
      this._endArgs = args;
    },
    _headers: headers,
  };
  return { req: {}, res };
}

// ─── Header presence in prod mode ───────────────────────────────────────────

test('securityHeaders: prod sets HSTS', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.match(res.getHeader('Strict-Transport-Security'), /max-age=31536000/);
  assert.match(res.getHeader('Strict-Transport-Security'), /includeSubDomains/);
});

test('securityHeaders: prod sets X-Frame-Options DENY', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('X-Frame-Options'), 'DENY');
});

test('securityHeaders: prod sets X-Content-Type-Options nosniff', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('X-Content-Type-Options'), 'nosniff');
});

test('securityHeaders: prod sets Referrer-Policy', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('Referrer-Policy'), 'strict-origin-when-cross-origin');
});

test('securityHeaders: prod sets Permissions-Policy disabling powerful APIs', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  const pp = res.getHeader('Permissions-Policy');
  assert.match(pp, /camera=\(\)/);
  assert.match(pp, /microphone=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
  assert.match(pp, /payment=\(\)/);
});

test('securityHeaders: prod sets Cross-Origin-Opener-Policy', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('Cross-Origin-Opener-Policy'), 'same-origin');
});

test('securityHeaders: prod sets X-Permitted-Cross-Domain-Policies', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('X-Permitted-Cross-Domain-Policies'), 'none');
});

// ─── Dev mode behavior ──────────────────────────────────────────────────────

test('securityHeaders: dev does NOT set HSTS (localhost is HTTP)', () => {
  const mw = securityHeaders({ env: 'development' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('Strict-Transport-Security'), undefined);
});

test('securityHeaders: dev still sets X-Frame-Options + X-Content-Type-Options', () => {
  const mw = securityHeaders({ env: 'development' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('X-Frame-Options'), 'DENY');
  assert.strictEqual(res.getHeader('X-Content-Type-Options'), 'nosniff');
});

// ─── CSP profile selection via res.locals.cspMode ───────────────────────────

test('securityHeaders: defaults to api CSP profile (strictest)', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  res.end();
  const csp = res.getHeader('Content-Security-Policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  // API mode does NOT allow inline scripts
  assert.ok(!csp.includes("'unsafe-inline'"), 'api CSP must not allow unsafe-inline');
});

test('securityHeaders: res.locals.cspMode = "page" allows inline scripts', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  res.locals.cspMode = 'page';
  res.end();
  const csp = res.getHeader('Content-Security-Policy');
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
});

test('securityHeaders: res.locals.cspMode = "off" sets no CSP', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  res.locals.cspMode = 'off';
  res.end();
  assert.strictEqual(res.getHeader('Content-Security-Policy'), undefined);
});

test('securityHeaders: res.end forwards its arguments correctly', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  res.end('body', 'utf8');
  assert.strictEqual(res._ended, true);
  assert.deepStrictEqual(res._endArgs, ['body', 'utf8']);
});

// ─── Route override behavior ────────────────────────────────────────────────

test('securityHeaders: existing headers are not clobbered (route wins)', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  mw(req, res, () => {});
  assert.strictEqual(res.getHeader('X-Frame-Options'), 'SAMEORIGIN', 'route-set values should win');
});

test('securityHeaders: existing CSP is not clobbered', () => {
  const mw = securityHeaders({ env: 'production' });
  const { req, res } = makeFakeReqRes();
  mw(req, res, () => {});
  res.setHeader('Content-Security-Policy', 'custom-policy');
  res.end();
  assert.strictEqual(res.getHeader('Content-Security-Policy'), 'custom-policy');
});

// ─── Exports ────────────────────────────────────────────────────────────────

test('securityHeaders: exports the header maps + CSP profiles', () => {
  assert.ok(DEFAULT_HEADERS_PROD['Strict-Transport-Security']);
  assert.ok(DEFAULT_HEADERS_DEV['X-Frame-Options']);
  assert.ok(CSP_PROFILES.api);
  assert.ok(CSP_PROFILES.page);
  assert.strictEqual(CSP_PROFILES.off, null);
});
