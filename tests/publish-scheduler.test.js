'use strict';

// Smoke tests for the publish scheduler (feature #3): timezone-correct due
// selection + idempotent publish dispatch across content_assets + generated_content.

const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../services/publish-scheduler');

test('localHHMM: returns zero-padded HH:MM in the given timezone', () => {
  const at = new Date('2026-06-14T12:00:00Z');
  assert.equal(ps.localHHMM('UTC', at), '12:00');
  // Asia/Kolkata is UTC+5:30 → 17:30
  assert.equal(ps.localHHMM('Asia/Kolkata', at), '17:30');
});

test('assetDue: due only when slot <= local now', () => {
  assert.equal(ps.assetDue('06:00', '08:00'), true);
  assert.equal(ps.assetDue('20:00', '08:00'), false);
  assert.equal(ps.assetDue(null, '08:00'), false);
});

test('publishDueAssets: publishes a due asset (tz-aware) via injected publishAsset', async () => {
  const calls = [];
  const sbGet = async (table) => {
    if (table === 'content_assets') return [{ id: 'a1', business_id: 'b1', posting_time_local: '00:00' }]; // 00:00 is always <= now
    if (table === 'business_profiles') return [{ timezone: 'UTC' }];
    return [];
  };
  const out = await ps.publishDueAssets({
    deps: {
      sbGet,
      publishAsset: async ({ assetId }) => {
        calls.push(assetId);
        return { ok: true };
      },
      logger: {},
    },
  });
  assert.equal(out.assets_due, 1);
  assert.equal(out.assets_published, 1);
  assert.deepEqual(calls, ['a1']);
});

test('publishDueAssets: skips an asset whose slot has not arrived', async () => {
  const sbGet = async (table) => {
    if (table === 'content_assets') return [{ id: 'a2', business_id: 'b1', posting_time_local: '23:59' }];
    if (table === 'business_profiles') return [{ timezone: 'UTC' }];
    return [];
  };
  // now = 00:01 UTC → 23:59 slot is not due
  const out = await ps.publishDueAssets({
    deps: { sbGet, publishAsset: async () => assert.fail('should not publish'), logger: {} },
    now: new Date('2026-06-14T00:01:00Z'),
  });
  assert.equal(out.assets_due, 0);
  assert.equal(out.assets_published, 0);
});

test('publishDueScheduled: triggers publish-approved per due business (idempotent select)', async () => {
  const triggered = [];
  const sbGet = async (table, query) => {
    if (table === 'generated_content') {
      assert.match(query, /published_at=is\.null/); // idempotency: only unpublished
      assert.match(query, /scheduled_for=lte\./);
      return [{ business_id: 'b1' }, { business_id: 'b1' }, { business_id: 'b2' }];
    }
    return [];
  };
  const out = await ps.publishDueScheduled({
    deps: { sbGet, publishApprovedForBusiness: async (id) => triggered.push(id), logger: {} },
  });
  assert.equal(out.scheduled_businesses_due, 2); // deduped b1
  assert.equal(out.scheduled_triggered, 2);
  assert.deepEqual(triggered.sort(), ['b1', 'b2']);
});
