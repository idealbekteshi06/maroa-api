'use strict';

/**
 * tests/status-page.test.js
 *
 * Verifies routes/status-page.js renders a sensible HTML payload.
 * No full Express harness needed — register() just calls app.get,
 * we stub `app` and inspect the registered handler.
 */

const test = require('node:test');
const assert = require('node:assert');

const statusPage = require('../routes/status-page');

function makeFakeApp() {
  const routes = {};
  return {
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    _routes: routes,
  };
}

function makeRes() {
  const headers = {};
  let body = null;
  return {
    setHeader(k, v) {
      headers[k] = v;
    },
    send(payload) {
      body = payload;
      return this;
    },
    get _body() {
      return body;
    },
    get _headers() {
      return headers;
    },
  };
}

test('status-page: registers GET /status', () => {
  const app = makeFakeApp();
  statusPage.register({ app });
  assert.ok(app._routes['GET /status'], 'should register /status');
  assert.strictEqual(typeof app._routes['GET /status'], 'function');
});

test('status-page: handler returns HTML with proper headers', () => {
  const app = makeFakeApp();
  statusPage.register({ app });
  const handler = app._routes['GET /status'];
  const res = makeRes();
  handler({}, res);

  assert.strictEqual(res._headers['Content-Type'], 'text/html; charset=utf-8');
  assert.ok(res._headers['Cache-Control'].includes('max-age'));
  assert.ok(res._body.includes('<!DOCTYPE html>'), 'should be a real HTML doc');
});

test('status-page: HTML contains all 4 dependency labels', () => {
  const app = makeFakeApp();
  statusPage.register({ app });
  const handler = app._routes['GET /status'];
  const res = makeRes();
  handler({}, res);
  for (const label of ['supabase', 'anthropic', 'inngest', 'higgsfield']) {
    assert.ok(res._body.toLowerCase().includes(label), `HTML should reference ${label}`);
  }
});

test('status-page: HTML polls /readyz client-side', () => {
  const app = makeFakeApp();
  statusPage.register({ app });
  const handler = app._routes['GET /status'];
  const res = makeRes();
  handler({}, res);
  assert.ok(res._body.includes("fetch('/readyz'"), 'should poll /readyz');
  assert.ok(res._body.includes('setInterval'), 'should auto-refresh');
});

test('status-page: HTML is mobile-responsive (viewport meta)', () => {
  const app = makeFakeApp();
  statusPage.register({ app });
  const handler = app._routes['GET /status'];
  const res = makeRes();
  handler({}, res);
  assert.ok(res._body.includes('viewport'), 'should have viewport meta');
  assert.ok(res._body.includes('width=device-width'), 'responsive viewport');
});
