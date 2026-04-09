'use strict';

const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();

const MEMORY_TYPES = Object.freeze({
  CONTENT_WINS: 'content_wins',
  CONTENT_LOSSES: 'content_losses',
  PREFERENCES: 'preferences',
  CAMPAIGN_PATTERNS: 'campaign_patterns',
  AUDIENCE_BEHAVIOR: 'audience_behavior'
});

function apiRequest(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      port: 443,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sbHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };
}

async function storeMemory(userId, type, pattern, context = {}) {
  if (!userId || !type) throw new Error('userId and type are required');
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase env vars not configured');

  const payload = {
    user_id: userId,
    memory_type: type,
    action: context.action || null,
    platform: context.platform || null,
    content_snippet: context.contentSnippet || null,
    learned_pattern: pattern || null,
    metrics: context.metrics || {},
    created_at: new Date().toISOString()
  };

  const response = await apiRequest(
    'POST',
    `${SUPABASE_URL}/rest/v1/ai_memory`,
    { ...sbHeaders(), Prefer: 'return=representation' },
    payload
  );

  if (![200, 201].includes(response.status)) {
    throw new Error(`Failed to store memory: ${response.status}`);
  }

  return Array.isArray(response.body) ? response.body[0] : response.body;
}

async function getMemoryContext(userId) {
  if (!userId) throw new Error('userId is required');
  if (!SUPABASE_URL || !SUPABASE_KEY) return '';

  const query = [
    'select=memory_type,learned_pattern,platform,action,created_at',
    `user_id=eq.${encodeURIComponent(userId)}`,
    'order=created_at.desc',
    'limit=20'
  ].join('&');

  const response = await apiRequest('GET', `${SUPABASE_URL}/rest/v1/ai_memory?${query}`, sbHeaders());
  if (response.status !== 200 || !Array.isArray(response.body) || response.body.length === 0) return '';

  const grouped = response.body.reduce((acc, row) => {
    const k = row.memory_type || 'general';
    if (!acc[k]) acc[k] = [];
    acc[k].push(row.learned_pattern || 'pattern recorded');
    return acc;
  }, {});

  return Object.entries(grouped)
    .map(([type, patterns]) => `- ${type}: ${patterns.slice(0, 5).join('; ')}`)
    .join('\n');
}

module.exports = {
  MEMORY_TYPES,
  storeMemory,
  getMemoryContext
};
