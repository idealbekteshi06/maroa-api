'use strict';

/**
 * routes/api-tokens.js
 * ----------------------------------------------------------------------------
 * User-issuable API tokens. Backs Settings → API tokens in the dashboard
 * and the `npx maroa setup` flow.
 *
 *   POST   /api/tokens         create a new token (returns full secret ONCE)
 *   GET    /api/tokens         list this user's tokens (prefix only)
 *   DELETE /api/tokens/:id     revoke a token
 *
 * Storage shape (migration 076): one row per token with a bcrypt of the
 * secret. The full plaintext is never persisted — only returned in the
 * create response.
 *
 * Token format: `mroa_<random-32-byte-hex>` — the `mroa_` prefix lets
 * Maroa surface "this looks like an API token" in any leak scanner (and
 * matches the convention Stripe, GitHub, Linear use for safer-by-design
 * detection in CI gitleaks rules).
 *
 * Verification (still TODO at the route-layer middleware): a follow-up
 * change to middleware/authenticateUserId will accept either a Supabase
 * JWT or `Bearer mroa_...` and look up the user via api_tokens. For now
 * this endpoint mints + manages tokens; the consuming side keeps using
 * Supabase JWTs until that middleware ships.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'mroa_';
const SECRET_BYTES = 32; // 256-bit secret

// Lightweight bcrypt-compatible hash using PBKDF2 — Node built-in, no new
// dep. 100k iterations is comfortably above the OWASP minimum and runs in
// ~50ms server-side, which is the right cost for a 1×/day mint flow.
const PBKDF2_ITERS = 100_000;
const PBKDF2_KEYLEN = 64;

function hashSecret(secret, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto
    .pbkdf2Sync(secret, useSalt, PBKDF2_ITERS, PBKDF2_KEYLEN, 'sha512')
    .toString('hex');
  return `pbkdf2$${PBKDF2_ITERS}$${useSalt}$${derived}`;
}

function verifySecret(secret, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iters = Number(parts[1]);
    const salt = parts[2];
    const expected = parts[3];
    const derived = crypto
      .pbkdf2Sync(secret, salt, iters, PBKDF2_KEYLEN, 'sha512')
      .toString('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
}

function newToken() {
  const random = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const full = `${TOKEN_PREFIX}${random}`;
  const prefix = full.slice(0, 12);
  return { full, prefix };
}

function register({ app, requireAnyUserId, sbGet, sbPost, sbPatch, apiError, safePublicError, log, express }) {
  app.post(
    '/api/tokens',
    requireAnyUserId,
    express ? express.json({ limit: '4kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const userId = req.user?.id;
        if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
        const label = (req.body?.label || '').toString().trim().slice(0, 80);
        if (!label) return apiError(res, 400, 'VALIDATION_ERROR', 'label is required (max 80 chars)');
        const expiresInDays = Math.min(Math.max(Number(req.body?.expires_in_days) || 90, 1), 365);
        const { full, prefix } = newToken();
        const row = {
          user_id: userId,
          label,
          prefix,
          secret_hash: hashSecret(full),
          scopes: ['read', 'write'],
          expires_at: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
        };
        const inserted = await sbPost('api_tokens', row).catch((e) => {
          throw new Error(`api_tokens insert failed: ${e.message}`);
        });
        const stored = Array.isArray(inserted) ? inserted[0] : inserted;
        return res.json({
          ok: true,
          token: full, // ← the only place the full secret ever leaves the server
          id: stored?.id || null,
          prefix,
          label,
          expires_at: row.expires_at,
        });
      } catch (err) {
        log?.('/api/tokens', null, 'create failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
      }
    },
  );

  app.get('/api/tokens', requireAnyUserId, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
      const rows = await sbGet(
        'api_tokens',
        `user_id=eq.${encodeURIComponent(userId)}&select=id,label,prefix,scopes,last_used_at,expires_at,revoked_at,created_at&order=created_at.desc&limit=50`,
      );
      const tokens = (rows || []).map((r) => ({
        ...r,
        active: !r.revoked_at && new Date(r.expires_at) > new Date(),
      }));
      return res.json({ tokens });
    } catch (err) {
      log?.('/api/tokens', null, 'list failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });

  app.delete('/api/tokens/:id', requireAnyUserId, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
      const id = String(req.params.id || '');
      if (!id) return apiError(res, 400, 'VALIDATION_ERROR', 'token id required');
      // PostgREST filter — user can only revoke their own tokens.
      await sbPatch(
        'api_tokens',
        `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`,
        { revoked_at: new Date().toISOString() },
      );
      return res.json({ ok: true });
    } catch (err) {
      log?.('/api/tokens', null, 'revoke failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });
}

module.exports = { register, hashSecret, verifySecret, newToken };
