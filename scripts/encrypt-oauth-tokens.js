#!/usr/bin/env node
'use strict';

/**
 * scripts/encrypt-oauth-tokens.js — One-time backfill of OAuth tokens.
 *
 * After applying migration 056_oauth_token_encryption.sql, this script
 * reads every `businesses` row, encrypts any existing plaintext OAuth
 * token, and writes the ciphertext into the corresponding `*_enc` column.
 *
 * Idempotent — re-runs only touch rows where `*_enc` is NULL but the
 * legacy plaintext column has a value. Safe to run multiple times.
 *
 * Usage:
 *   OAUTH_TOKEN_ENC_KEY=$(openssl rand -hex 32) \
 *   SUPABASE_URL=https://... SUPABASE_KEY=... \
 *   node scripts/encrypt-oauth-tokens.js [--dry-run]
 *
 * The first time you run this, capture OAUTH_TOKEN_ENC_KEY and add it to
 * Railway / your secrets manager — without it the next decrypt will fail.
 *
 * After successful backfill + production verification, schedule migration
 * 060_drop_plaintext_oauth_tokens.sql to remove the legacy columns.
 */

const oauthCrypto = require('../lib/oauthCrypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '')
  .replace(/[^\x20-\x7E]/g, '')
  .trim();
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY env var.');
  process.exit(1);
}
if (!oauthCrypto.isEnabled()) {
  console.error('Missing OAUTH_TOKEN_ENC_KEY env var. Generate with: openssl rand -hex 32');
  process.exit(1);
}

const TOKEN_COLUMNS = [
  'google_refresh_token',
  'meta_access_token',
  'facebook_page_access_token',
  'google_access_token',
];

const selectList = ['id', ...TOKEN_COLUMNS, ...TOKEN_COLUMNS.map((c) => `${c}_enc`)].join(',');

async function sb(method, path, body) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  const res = await fetch(u.toString(), {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function run() {
  // PostgREST max rows per page = 1000 default. Iterate with `range`.
  const PAGE = 500;
  let offset = 0;
  let totalRows = 0;
  let totalEncrypted = 0;
  const errors = [];

  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/businesses?select=${selectList}&limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    totalRows += rows.length;

    for (const row of rows) {
      const patch = {};
      for (const col of TOKEN_COLUMNS) {
        const plain = row[col];
        const encExisting = row[`${col}_enc`];
        if (plain && !encExisting) {
          patch[`${col}_enc`] = oauthCrypto.encrypt(plain);
        }
      }
      if (Object.keys(patch).length === 0) continue;

      if (DRY_RUN) {
        console.log(`[dry-run] would encrypt ${Object.keys(patch).join(', ')} for business ${row.id}`);
        totalEncrypted++;
        continue;
      }
      try {
        await sb('PATCH', `businesses?id=eq.${encodeURIComponent(row.id)}`, patch);
        totalEncrypted++;
        if (totalEncrypted % 25 === 0) console.log(`  encrypted ${totalEncrypted} so far...`);
      } catch (e) {
        errors.push({ id: row.id, error: e.message });
      }
    }

    offset += PAGE;
    if (rows.length < PAGE) break;
  }

  console.log(
    `\nDone. Scanned ${totalRows} rows, encrypted ${totalEncrypted} business${totalEncrypted === 1 ? '' : 'es'}.`
  );
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`  ${e.id}: ${e.error}`);
    if (errors.length > 10) console.log(`  ... + ${errors.length - 10} more`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
