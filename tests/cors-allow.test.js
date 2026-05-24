'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { once } = require('node:events');
const cors = require('cors');
const { isCorsOriginAllowed } = require('../lib/corsAllow');

test('isCorsOriginAllowed allows maroa.ai and project preview hosts', () => {
  assert.strictEqual(isCorsOriginAllowed('https://maroa.ai'), true);
  // Project preview deploys (Vercel/Lovable) carry the "maroa" project token.
  assert.strictEqual(isCorsOriginAllowed('https://maroa-ai-marketing-automator-git-main.vercel.app'), true);
  assert.strictEqual(isCorsOriginAllowed('https://maroa-preview.lovable.app'), true);
  // Arbitrary third-party preview hosts must NOT be reflected with credentials.
  assert.strictEqual(isCorsOriginAllowed('https://app-abc.vercel.app'), false);
  assert.strictEqual(isCorsOriginAllowed('https://evil.example.com'), false);
});

test('rejected CORS origin returns 403 not 500', async () => {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isCorsOriginAllowed(origin)) {
      return res.status(403).json({ error: { code: 'CORS_FORBIDDEN', message: 'Origin not allowed' } });
    }
    return next();
  });
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isCorsOriginAllowed(origin)) return callback(null, true);
        return callback(null, false);
      },
    })
  );
  app.get('/api/ping', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await once(server.listen(0), 'listening');
  const port = server.address().port;

  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/ping',
          method: 'GET',
          headers: { Origin: 'https://evil.example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 403);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
