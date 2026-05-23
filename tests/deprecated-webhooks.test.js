'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { once } = require('node:events');
const { deprecatedWebhooksMiddleware } = require('../lib/deprecatedWebhooks');

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

test('deprecatedWebhooksMiddleware must be invoked (factory returns handler)', async () => {
  const app = express();
  app.use(deprecatedWebhooksMiddleware());
  app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

  const server = http.createServer(app);
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  try {
    const status = await httpGet(`http://127.0.0.1:${port}/healthz`);
    assert.equal(status, 200);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
