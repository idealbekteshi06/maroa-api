'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertBusinessOwner, extractBusinessId } = require('../lib/assertBusinessOwner');

test('extractBusinessId reads params and body', () => {
  assert.equal(extractBusinessId({ params: { businessId: 'a' }, body: {} }), 'a');
  assert.equal(extractBusinessId({ body: { business_id: 'b' } }), 'b');
});

test('assertBusinessOwner allows webhook auth without DB', async () => {
  const res = { statusCode: 0, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  const ok = await assertBusinessOwner(
    { authSource: 'webhook', user: null },
    res,
    '11111111-1111-4111-8111-111111111111',
    {
      sbGet: async () => {
        throw new Error('should not call');
      },
      apiError: (r, s, c, m) => r.status(s).json({ error: c, message: m }),
    }
  );
  assert.equal(ok, true);
});

test('extractBusinessId reads camelCase businessId in body/query', () => {
  assert.equal(extractBusinessId({ body: { businessId: 'c' } }), 'c');
  assert.equal(extractBusinessId({ query: { businessId: 'd' } }), 'd');
});

function mkRes() {
  const res = { statusCode: 0, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  return res;
}

test('assertBusinessOwner allows agency member via workspace client relationship', async () => {
  const biz = '22222222-2222-4222-8222-222222222222';
  const user = '11111111-1111-4111-8111-111111111111';
  const res = mkRes();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: biz, user_id: '99999999-9999-4999-8999-999999999999' }];
    if (table === 'client_relationships') return [{ workspace_id: 'ws-1' }];
    if (table === 'workspace_members') return [{ workspace_id: 'ws-1' }];
    return [];
  };
  const ok = await assertBusinessOwner({ authSource: 'jwt', user: { id: user } }, res, biz, {
    sbGet,
    apiError: (r, s, c, m) => r.status(s).json({ error: c, message: m }),
  });
  assert.equal(ok, true);
});

test('assertBusinessOwner denies non-owner non-member', async () => {
  const biz = '22222222-2222-4222-8222-222222222222';
  const user = '11111111-1111-4111-8111-111111111111';
  const res = mkRes();
  const sbGet = async (table) => {
    if (table === 'businesses') return [{ id: biz, user_id: '99999999-9999-4999-8999-999999999999' }];
    return []; // no client relationship / membership
  };
  const ok = await assertBusinessOwner({ authSource: 'jwt', user: { id: user } }, res, biz, {
    sbGet,
    apiError: (r, s, c, m) => r.status(s).json({ error: c, message: m }),
  });
  assert.equal(ok, false);
  assert.equal(res.statusCode, 403);
});

test('assertBusinessOwner blocks JWT user who does not own business', async () => {
  const res = { statusCode: 0, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  const biz = '22222222-2222-4222-8222-222222222222';
  const ok = await assertBusinessOwner(
    { authSource: 'jwt', user: { id: '11111111-1111-4111-8111-111111111111' } },
    res,
    biz,
    {
      sbGet: async () => [{ id: biz, user_id: '99999999-9999-4999-8999-999999999999' }],
      apiError: (r, s, c, m) => r.status(s).json({ error: c, message: m }),
    }
  );
  assert.equal(ok, false);
  assert.equal(res.statusCode, 403);
});
