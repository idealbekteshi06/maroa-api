'use strict';
// TODO (post-merge, manual): update the Paddle product IDs in the Paddle
// dashboard to match the May 2026 pricing reset:
//   growth → $149/mo (monthly) + $1,250/yr (annual, 30% off)
//   agency → $599/mo (monthly) + $5,030/yr (annual, 30% off)
// Old SKUs (free / starter €19 / growth €39 / agency €69) should be
// retired — kept active only long enough to grandfather legacy customers.
// Keep the env-var product IDs in sync with the dashboard SKUs.
const crypto = require('crypto');
const https = require('https');

const PADDLE_API_KEY = (process.env.PADDLE_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').trim(); // 'sandbox' or 'production'
const PADDLE_BASE = PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';

function paddleRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PADDLE_BASE + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        Authorization: `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Paddle request timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function createCheckoutSession({ priceId, businessId, plan, customerEmail, successUrl, cancelUrl }) {
  const r = await paddleRequest('POST', '/transactions', {
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: { business_id: businessId, plan },
    checkout: {
      url: successUrl || 'https://maroa-ai-marketing-automator.vercel.app/dashboard?upgraded=true',
    },
    ...(customerEmail ? { customer: { email: customerEmail } } : {}),
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`Paddle create transaction failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const txn = r.body?.data;
  return {
    transaction_id: txn?.id,
    checkout_url: txn?.checkout?.url || null,
  };
}

async function getSubscription(subscriptionId) {
  const r = await paddleRequest('GET', `/subscriptions/${subscriptionId}`);
  if (r.status !== 200) {
    throw new Error(`Paddle get subscription failed: ${r.status}`);
  }
  return r.body?.data;
}

async function cancelSubscription(subscriptionId, effectiveFrom = 'next_billing_period') {
  const r = await paddleRequest('POST', `/subscriptions/${subscriptionId}/cancel`, {
    effective_from: effectiveFrom,
  });
  if (r.status !== 200) {
    throw new Error(`Paddle cancel subscription failed: ${r.status}`);
  }
  return r.body?.data;
}

// 5-minute replay tolerance. Paddle includes `ts=<unix-seconds>;h1=<hex>` in
// the signature header. We require BOTH a valid HMAC AND a recent timestamp.
// Without this check, a single captured webhook can be replayed forever —
// each replay would re-grant plans, re-fire cold-start, double-count usage.
const PADDLE_REPLAY_WINDOW_SECONDS = 300;

function verifyWebhookSignature(rawBody, signature, secret, now = Date.now()) {
  if (!signature || !secret) return false;
  // Paddle sends ts;h1=hash format
  const parts = signature.split(';');
  const tsStr = parts.find((p) => p.startsWith('ts='));
  const h1Str = parts.find((p) => p.startsWith('h1='));
  if (!tsStr || !h1Str) return false;
  const tsRaw = tsStr.replace('ts=', '').trim();
  const h1 = h1Str.replace('h1=', '').trim();
  const tsSeconds = Number(tsRaw);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return false;
  // Reject anything older than 5 minutes OR more than 5 minutes in the
  // future (clock skew tolerance both directions).
  const ageSec = Math.abs(now / 1000 - tsSeconds);
  if (ageSec > PADDLE_REPLAY_WINDOW_SECONDS) return false;

  const payload = `${tsRaw}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(h1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  createCheckoutSession,
  getSubscription,
  cancelSubscription,
  verifyWebhookSignature,
  PADDLE_API_KEY,
};
