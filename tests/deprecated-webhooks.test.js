'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { deprecatedWebhooksMiddleware } = require('../lib/deprecatedWebhooks');

test('deprecatedWebhooksMiddleware must be invoked (factory returns handler)', async () => {
  const app = express();
  app.use(deprecatedWebhooksMiddleware());
  app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const status = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/healthz`, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
