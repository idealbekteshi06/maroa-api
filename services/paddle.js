'use strict';
const crypto = require('crypto');
const https = require('https');

const PADDLE_API_KEY = (process.env.PADDLE_API_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();
const PADDLE_ENV = (process.env.PADDLE_ENV || 'sandbox').trim(); // 'sandbox' or 'production'
const PADDLE_BASE = PADDLE_ENV === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

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
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
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
    ...(customerEmail ? { customer: { email: customerEmail } } : {})
  });
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`Paddle create transaction failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const txn = r.body?.data;
  return {
    transaction_id: txn?.id,
    checkout_url: txn?.checkout?.url || null
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
    effective_from: effectiveFrom
  });
  if (r.status !== 200) {
    throw new Error(`Paddle cancel subscription failed: ${r.status}`);
  }
  return r.body?.data;
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  // Paddle sends ts;h1=hash format
  const parts = signature.split(';');
  const tsStr = parts.find(p => p.startsWith('ts='));
  const h1Str = parts.find(p => p.startsWith('h1='));
  if (!tsStr || !h1Str) return false;
  const ts = tsStr.replace('ts=', '');
  const h1 = h1Str.replace('h1=', '');
  const payload = `${ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(h1), Buffer.from(expected));
}

module.exports = {
  createCheckoutSession,
  getSubscription,
  cancelSubscription,
  verifyWebhookSignature,
  PADDLE_API_KEY
};
