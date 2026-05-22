'use strict';

const https = require('https');

function cleanEnv(v) {
  return String(v || '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function getSeedConfig() {
  const url = cleanEnv(process.env.SUPABASE_URL);
  const key = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);
  return { url, key, ok: !!(url && key) };
}

function sbRequest(method, table, { query = '', body = null, prefer = 'return=representation' } = {}) {
  const { url, key } = getSeedConfig();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_KEY required');

  return new Promise((resolve, reject) => {
    const path = `/rest/v1/${table}${query ? (query.startsWith('?') ? query : `?${query}`) : ''}`;
    const u = new URL(path, url);
    const payload = body == null ? null : JSON.stringify(body);
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              resolve(text);
            }
            return;
          }
          reject(new Error(`Supabase ${method} ${table} ${res.statusCode}: ${text.slice(0, 300)}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function sbUpsert(table, rows, onConflict) {
  const conflict = onConflict || 'id';
  return sbRequest('POST', table, {
    query: `?on_conflict=${encodeURIComponent(conflict)}`,
    body: rows,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

async function sbInsert(table, rows) {
  return sbRequest('POST', table, { body: rows, prefer: 'return=representation' });
}

async function sbSelect(table, query) {
  return sbRequest('GET', table, { query });
}

async function sbCount(table, filter = '') {
  const rows = await sbSelect(table, `${filter}&select=id&limit=1`);
  if (Array.isArray(rows)) {
    const all = await sbSelect(table, `${filter}&select=id`);
    return Array.isArray(all) ? all.length : 0;
  }
  return 0;
}

/** HEAD count via Content-Range when available; fallback to select length. */
async function sbCountExact(table, filter = '') {
  try {
    const rows = await sbSelect(table, `${filter}&select=id`);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  getSeedConfig,
  sbRequest,
  sbUpsert,
  sbInsert,
  sbSelect,
  sbCountExact,
};
