# services/oauth/

Meta + Google OAuth flows. Per-customer token capture for ads + page
posting + Instagram + Threads.

## Files

| File | What |
|---|---|
| `meta.js` | Meta OAuth (FB + IG + Threads). Authorization code → short-lived → long-lived (60d) token. Fetches ad accounts, pages, IG accounts. |
| `google.js` | Google OAuth (Ads + userinfo). Authorization code → refresh_token. Lists accessible Ads customers. |

## State token scheme

Both providers sign state with HMAC(N8N_WEBHOOK_SECRET) and bind to:
- `businessId` (UUID)
- `userId` (UUID — the authenticated Supabase user who initiated)
- 16-byte random nonce (replay protection)
- timestamp (30-min expiry)

The `/start` route REQUIRES a Supabase JWT (Authorization header OR
`?token=` query for browser redirects) and verifies via the
ownership check that the JWT user owns `businessId` before issuing
state. See [ADR-0002](../../docs/adr/0002-app-side-oauth-token-encryption.md).

## Token encryption at rest

OAuth tokens (Meta access, Meta page access, Google refresh) are
encrypted via `lib/oauthCrypto.js` (AES-256-GCM, key from
`OAUTH_TOKEN_ENC_KEY` env). Dual-write transition: new tokens land in
both legacy plaintext column AND new `*_enc` column. Migration 060
(future) drops the plaintext columns once `scripts/encrypt-oauth-tokens.js`
backfill completes.

Read path: every consumer uses `oauthCrypto.readToken(row, 'col_name')`
which prefers encrypted, falls back to legacy.

## Public API

```js
const { registerMetaOAuthRoutes } = require('./services/oauth/meta');
const { registerGoogleOAuthRoutes } = require('./services/oauth/google');

registerMetaOAuthRoutes({ app, sbGet, sbPatch, sbPost, apiError, logger, verifyUserJwt });
registerGoogleOAuthRoutes({ app, sbGet, sbPatch, sbPost, apiError, logger, verifyUserJwt });
```

## Routes mounted

- `GET  /webhook/oauth/meta/start`     — JWT-protected, redirects to FB consent
- `GET  /webhook/oauth/meta/callback`  — exchanges code, persists tokens
- `GET  /webhook/oauth/meta/health`    — token validity probe
- `GET  /webhook/oauth/google/start`   — JWT-protected, redirects to Google consent
- `GET  /webhook/oauth/google/callback`
- `GET  /webhook/oauth/google/health`

## Tests

`tests/oauth-flows.test.js` covers state signing/verification with the
new userId binding, expiry, tampering detection, and cross-provider
verification (intentional — same HMAC scheme; account-takeover
mitigated by separate callback URLs + ownership check at `/start`).
