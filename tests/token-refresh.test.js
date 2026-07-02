'use strict';

// OAuth token refresh (LinkedIn/Twitter/TikTok) — services/token-refresh.
// Covers: happy-path refresh + rotated-refresh-token persistence, definitive
// rejection → connected=false + reconnect event, transient errors touch
// nothing, no-refresh-token skip, the sweep aggregation, and the WF1
// publisher's Twitter 401 refresh-and-retry.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// The service refuses to run without the encryption key (a rotated refresh
// token it can't persist = dead connection), so set one before requiring.
process.env.OAUTH_TOKEN_ENC_KEY = crypto.randomBytes(32).toString('hex');

const createTokenRefresh = require('../services/token-refresh');
const createPublisher = require('../services/wf1/publish');
const oauthCrypto = require('../lib/oauthCrypto');

// With the key set, writes land in *_enc columns; decrypt to assert values.
const dec = (blob) => (blob ? oauthCrypto.decrypt(blob) : undefined);

const ENV = {
  LINKEDIN_CLIENT_ID: 'li-id',
  LINKEDIN_CLIENT_SECRET: 'li-secret',
  TWITTER_CLIENT_ID: 'tw-id',
  TWITTER_CLIENT_SECRET: 'tw-secret',
  TIKTOK_CLIENT_KEY: 'tt-key',
  TIKTOK_CLIENT_SECRET: 'tt-secret',
};

function harness({ apiResponse, apiError } = {}) {
  const patches = [];
  const posts = [];
  const requests = [];
  const deps = {
    sbGet: async () => [],
    sbPatch: async (table, filter, patch) => {
      patches.push({ table, filter, patch });
      return true;
    },
    sbPost: async (table, row) => {
      posts.push({ table, row });
      return [row];
    },
    apiRequest: async (method, url, headers, body) => {
      requests.push({ method, url, headers, body });
      if (apiError) throw apiError;
      return apiResponse || { status: 200, body: { access_token: 'new-access', refresh_token: 'new-refresh' } };
    },
    env: ENV,
    logger: null,
  };
  return { deps, patches, posts, requests };
}

test('refreshPlatform: twitter success persists new access + ROTATED refresh token', async () => {
  const { deps, patches, requests } = harness();
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', twitter_refresh_token: 'old-refresh' },
    platform: 'twitter',
  });
  assert.equal(r.ok, true);
  assert.equal(r.accessToken, 'new-access');
  // Basic auth header + refresh_token grant
  assert.match(requests[0].headers.Authorization, /^Basic /);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  const patch = patches.find((p) => p.table === 'businesses');
  assert.ok(patch);
  assert.equal(dec(patch.patch.twitter_access_token_enc), 'new-access');
  assert.equal(dec(patch.patch.twitter_refresh_token_enc), 'new-refresh', 'rotated refresh token MUST be persisted');
  assert.equal(patch.patch.twitter_connected, true);
});

test('refreshPlatform: tiktok handles the data-wrapped response shape', async () => {
  const { deps, patches } = harness({
    apiResponse: { status: 200, body: { data: { access_token: 'tt-access', refresh_token: 'tt-rotated' } } },
  });
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', tiktok_refresh_token: 'old' },
    platform: 'tiktok',
  });
  assert.equal(r.ok, true);
  const patch = patches.find((p) => p.table === 'businesses');
  assert.equal(dec(patch.patch.tiktok_access_token_enc), 'tt-access');
  assert.equal(dec(patch.patch.tiktok_refresh_token_enc), 'tt-rotated');
});

test('refreshPlatform: 401 rejection flips connected=false + writes reconnect event', async () => {
  const { deps, patches, posts } = harness({
    apiResponse: { status: 401, body: { error: 'invalid_grant' } },
  });
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', linkedin_refresh_token: 'dead' },
    platform: 'linkedin',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reconnectRequired, true);
  const patch = patches.find((p) => p.table === 'businesses');
  assert.equal(patch.patch.linkedin_connected, false);
  const evt = posts.find((p) => p.table === 'events');
  assert.equal(evt.row.kind, 'oauth.reconnect_required');
  assert.equal(evt.row.payload.platform, 'linkedin');
});

test('refreshPlatform: 5xx is transient — state untouched', async () => {
  const { deps, patches, posts } = harness({ apiResponse: { status: 503, body: {} } });
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', twitter_refresh_token: 'x' },
    platform: 'twitter',
  });
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
  assert.equal(patches.length, 0, 'must not touch the row on a transient error');
  assert.equal(posts.length, 0, 'must not emit reconnect events on a transient error');
});

test('refreshPlatform: network error is transient — state untouched', async () => {
  const { deps, patches } = harness({ apiError: new Error('ECONNRESET') });
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', tiktok_refresh_token: 'x' },
    platform: 'tiktok',
  });
  assert.equal(r.transient, true);
  assert.equal(patches.length, 0);
});

test('refreshPlatform: no refresh token → skip, do NOT kill the connection', async () => {
  const { deps, patches } = harness();
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({ business: { id: 'b1' }, platform: 'linkedin' });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_refresh_token');
  assert.equal(patches.length, 0, 'LinkedIn without a refresh token may still have a live access token');
});

test('refreshPlatform: missing client credentials → skip', async () => {
  const { deps } = harness();
  deps.env = {}; // no client ids/secrets configured
  const svc = createTokenRefresh(deps);
  const r = await svc.refreshPlatform({
    business: { id: 'b1', twitter_refresh_token: 'x' },
    platform: 'twitter',
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'client_credentials_missing');
});

test('sweepAll: refreshes every connected platform per business and aggregates', async () => {
  const { deps } = harness();
  deps.sbGet = async (table, q) => {
    assert.equal(table, 'businesses');
    assert.match(q, /or=\(linkedin_connected\.eq\.true,twitter_connected\.eq\.true,tiktok_connected\.eq\.true\)/);
    return [
      {
        id: 'b1',
        twitter_connected: true,
        tiktok_connected: true,
        linkedin_connected: false,
        twitter_refresh_token: 'tw',
        tiktok_refresh_token: 'tt',
      },
      { id: 'b2', linkedin_connected: true }, // connected but no refresh token → skipped
    ];
  };
  const svc = createTokenRefresh(deps);
  const out = await svc.sweepAll({ limit: 50 });
  assert.equal(out.ok, true);
  assert.equal(out.businesses, 2);
  assert.equal(out.refreshed, 2, 'b1 twitter + b1 tiktok');
  assert.equal(out.skipped, 1, 'b2 linkedin has no refresh token');
  assert.equal(out.reconnectRequired, 0);
});

// ─── WF1 publisher: Twitter 401 → refresh → retry once ─────────────────────

test('publishToTwitter path: 401 triggers refresh and the retry succeeds', async () => {
  const calls = [];
  const apiRequest = async (method, url, headers) => {
    calls.push({ url, auth: headers.Authorization });
    if (url === 'https://api.twitter.com/2/tweets') {
      // First attempt with the stale token 401s; retry with fresh token wins.
      return headers.Authorization === 'Bearer stale-token'
        ? { status: 401, body: { title: 'Unauthorized' } }
        : { status: 201, body: { data: { id: 'tweet-1' } } };
    }
    throw new Error(`unexpected url ${url}`);
  };
  const tokenRefresh = {
    refreshPlatform: async ({ platform }) => {
      assert.equal(platform, 'twitter');
      return { ok: true, accessToken: 'fresh-token' };
    },
  };
  const db = {
    content_assets: [{ id: 'a1', business_id: 'b1', concept_id: 'c1', caption: 'hello world' }],
    content_concepts: [{ id: 'c1', platform: 'twitter' }],
    businesses: [{ id: 'b1', twitter_access_token: 'stale-token' }],
  };
  const publisher = createPublisher({
    apiRequest,
    sbGet: async (table) => db[table] || [],
    sbPost: async () => [{}],
    sbPatch: async () => true,
    logger: null,
    tokenRefresh,
  });
  const r = await publisher.publishAsset({ assetId: 'a1' });
  assert.equal(r.ok, true, `expected retry to succeed, got ${JSON.stringify(r)}`);
  assert.equal(r.postId, 'tweet-1');
  const tweetCalls = calls.filter((c) => c.url.includes('/2/tweets'));
  assert.equal(tweetCalls.length, 2, 'stale attempt + fresh retry');
  assert.equal(tweetCalls[1].auth, 'Bearer fresh-token');
});

test('publishToTwitter path: 401 with failing refresh reports a clean failure', async () => {
  const apiRequest = async (method, url) => {
    if (url === 'https://api.twitter.com/2/tweets') return { status: 401, body: { title: 'Unauthorized' } };
    throw new Error(`unexpected url ${url}`);
  };
  const db = {
    content_assets: [{ id: 'a1', business_id: 'b1', concept_id: 'c1', caption: 'x' }],
    content_concepts: [{ id: 'c1', platform: 'twitter' }],
    businesses: [{ id: 'b1', twitter_access_token: 'stale' }],
  };
  const publisher = createPublisher({
    apiRequest,
    sbGet: async (table) => db[table] || [],
    sbPost: async () => [{}],
    sbPatch: async () => true,
    logger: null,
    tokenRefresh: { refreshPlatform: async () => ({ ok: false, reconnectRequired: true }) },
  });
  const r = await publisher.publishAsset({ assetId: 'a1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Twitter publish 401/);
});
