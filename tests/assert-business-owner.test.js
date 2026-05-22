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
    { sbGet: async () => { throw new Error('should not call'); }, apiError: (r, s, c, m) => r.status(s).json({ error: c, message: m }) }
  );
  assert.equal(ok, true);
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
