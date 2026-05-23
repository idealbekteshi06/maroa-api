'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { once } = require('node:events');

test('paddle webhook route registered before express.json receives Buffer body', async () => {
  const paddleWebhookRawBody = express.raw({ type: 'application/json' });
  const app = express();
  app.post('/webhook/paddle-webhook', paddleWebhookRawBody, (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), type: typeof req.body });
  });
  app.use(express.json({ limit: '10mb' }));
  app.post('/webhook/paddle-webhook-json', (req, res) => {
    res.json({ isBuffer: Buffer.isBuffer(req.body), type: typeof req.body });
  });

  const server = http.createServer(app);
  await once(server.listen(0), 'listening');
  const port = server.address().port;

  const post = (path, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  try {
    const rawRoute = await post('/webhook/paddle-webhook', '{"ok":true}');
    assert.strictEqual(rawRoute.isBuffer, true);
    const jsonRoute = await post('/webhook/paddle-webhook-json', '{"ok":true}');
    assert.strictEqual(jsonRoute.isBuffer, false);
    assert.strictEqual(jsonRoute.type, 'object');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
