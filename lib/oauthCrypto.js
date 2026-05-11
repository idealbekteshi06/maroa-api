'use strict';

/**
 * lib/oauthCrypto.js — AES-256-GCM at-rest encryption for OAuth tokens.
 *
 * Why: refresh_token + long-lived access_token for Google Ads, Meta, TikTok
 * are stored in the `businesses` table. A Supabase breach + plaintext storage
 * = every customer's ad account is hijacked. Encrypting at rest moves the
 * trust boundary from Supabase to the app's encryption key (kept in env /
 * secrets manager, never written to disk inside the DB).
 *
 * Scheme: AES-256-GCM (authenticated encryption, integrity + confidentiality)
 * Key:    32 random bytes hex-encoded in OAUTH_TOKEN_ENC_KEY env var.
 *         Generate with: openssl rand -hex 32
 *
 * Blob format (text-encoded so it fits a text column):
 *   v1:<iv_hex(24)>:<tag_hex(32)>:<ciphertext_hex>
 *   - v1     scheme version, for forward compat (rotate to v2 with new algo)
 *   - iv     12 random bytes (24 hex chars) — fresh per encrypt
 *   - tag    16-byte GCM auth tag (32 hex chars) — proves integrity
 *   - ct     ciphertext (variable length hex)
 *
 * Failure modes:
 *   - decrypt(badInput)           → throws Error('decrypt failed')
 *   - decrypt(empty/null)         → null  (caller falls back to legacy)
 *   - encrypt() w/o key set       → throws Error('OAUTH_TOKEN_ENC_KEY not set')
 *   - encrypt(empty/null)         → null  (don't encrypt nothing)
 *
 * Public API:
 *   encrypt(plaintext) → blob | null
 *   decrypt(blob)      → plaintext | null
 *   isEnabled()        → bool (key present, ready to encrypt)
 */

const crypto = require('crypto');

const SCHEME = 'v1';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.OAUTH_TOKEN_ENC_KEY || '').trim();
  if (!raw) return null;
  let buf;
  try {
    buf = Buffer.from(raw, 'hex');
  } catch {
    throw new Error('OAUTH_TOKEN_ENC_KEY must be hex-encoded');
  }
  if (buf.length !== 32) {
    throw new Error(`OAUTH_TOKEN_ENC_KEY must decode to 32 bytes (got ${buf.length}). Generate with: openssl rand -hex 32`);
  }
  cachedKey = buf;
  return cachedKey;
}

function isEnabled() {
  try { return !!getKey(); } catch { return false; }
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = getKey();
  if (!key) throw new Error('OAUTH_TOKEN_ENC_KEY not set — cannot encrypt');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SCHEME}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(blob) {
  if (!blob || typeof blob !== 'string') return null;
  const parts = blob.split(':');
  if (parts.length !== 4) {
    throw new Error('decrypt failed: malformed blob');
  }
  const [scheme, ivHex, tagHex, ctHex] = parts;
  if (scheme !== SCHEME) {
    throw new Error(`decrypt failed: unsupported scheme "${scheme}" (expected ${SCHEME})`);
  }
  const key = getKey();
  if (!key) throw new Error('OAUTH_TOKEN_ENC_KEY not set — cannot decrypt');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  if (iv.length !== IV_LEN || tag.length !== 16) {
    throw new Error('decrypt failed: bad iv/tag length');
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    throw new Error('decrypt failed: bad ciphertext or wrong key');
  }
}

/**
 * Helper for OAuth save paths — encrypts only when key is configured.
 * Returns an object spread suitable for sbPatch:
 *
 *   const enc = oauthCrypto.encryptIfEnabled('meta_access_token', token);
 *   await sbPatch('businesses', `id=eq.${id}`, { ...patch, ...enc });
 *
 * If the key isn't configured, returns {} and the caller's plaintext column
 * is the only stored copy. Letting the app start without the key is a
 * conscious choice — encryption is preferred but losing customer
 * onboarding because the key wasn't rotated yet is worse.
 */
function encryptIfEnabled(legacyColumn, value) {
  if (!value) return {};
  if (!isEnabled()) return {};
  const encColumn = `${legacyColumn}_enc`;
  return { [encColumn]: encrypt(value) };
}

/**
 * Read helper — prefers encrypted column, falls back to legacy plaintext.
 * Use everywhere OAuth tokens are read from `businesses`.
 *
 *   const refresh = oauthCrypto.readToken(row, 'google_refresh_token');
 */
function readToken(row, legacyColumn) {
  if (!row) return null;
  const enc = row[`${legacyColumn}_enc`];
  if (enc) {
    try { return decrypt(enc); }
    catch { /* fall through to legacy */ }
  }
  return row[legacyColumn] || null;
}

module.exports = {
  encrypt,
  decrypt,
  encryptIfEnabled,
  readToken,
  isEnabled,
  SCHEME,
};
