#!/usr/bin/env node
/**
 * Inject all 15 marketing skill frameworks into Pinecone.
 *
 * Usage:
 *   node scripts/injectMarketingSkills.js
 *
 * Requires env vars: OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST
 * Or run via the API: POST /api/inject-marketing-skills
 */
'use strict';

const https = require('https');
const http  = require('http');
const { injectAllSkills } = require('../services/marketingKnowledgeBase');

const clean = v => (v || '').replace(/[^\x20-\x7E]/g, '').trim();
const OPENAI_API_KEY   = clean(process.env.OPENAI_API_KEY);
const PINECONE_API_KEY = clean(process.env.PINECONE_API_KEY);
const PINECONE_HOST    = clean(process.env.PINECONE_HOST);

function apiRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const proto = u.protocol === 'https:' ? https : http;
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = proto.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const r = await apiRequest('POST', 'https://api.openai.com/v1/embeddings',
    { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    { model: 'text-embedding-3-small', input: text.slice(0, 8000) });
  if (r.status !== 200) throw new Error(`OpenAI embed: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body?.data?.[0]?.embedding || [];
}

async function pineconeUpsert(vectors) {
  if (!PINECONE_API_KEY || !PINECONE_HOST) throw new Error('Pinecone not configured');
  const r = await apiRequest('POST', `${PINECONE_HOST}/vectors/upsert`,
    { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
    { vectors });
  if (![200,201].includes(r.status)) throw new Error(`Pinecone upsert: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
  return r.body;
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  maroa.ai Marketing Knowledge Injection  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  if (!OPENAI_API_KEY) { console.error('❌ OPENAI_API_KEY not set'); process.exit(1); }
  if (!PINECONE_API_KEY) { console.error('❌ PINECONE_API_KEY not set'); process.exit(1); }
  if (!PINECONE_HOST) { console.error('❌ PINECONE_HOST not set'); process.exit(1); }

  console.log('✓ OpenAI key:', OPENAI_API_KEY.slice(0, 12) + '...');
  console.log('✓ Pinecone host:', PINECONE_HOST.slice(0, 30) + '...');
  console.log();

  await injectAllSkills(getEmbedding, pineconeUpsert);

  console.log();
  console.log('✅ All marketing skill frameworks injected into Pinecone!');
  console.log('   maroa.ai AI brain now has expert marketing knowledge.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
