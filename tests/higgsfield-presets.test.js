'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { listPresetCatalog, syncPresetCatalog, PRESETS } = require('../services/higgsfield/cameraPresets');

test('listPresetCatalog: returns one row per in-code preset in table shape', () => {
  const catalog = listPresetCatalog();
  assert.strictEqual(catalog.length, Object.keys(PRESETS).length);
  for (const row of catalog) {
    assert.ok(row.preset_id, 'preset_id present');
    assert.ok(row.name, 'name present');
    assert.strictEqual(typeof row.description, 'string');
    assert.ok(Array.isArray(row.supported_industries));
  }
  const social = catalog.find((r) => r.preset_id === 'social');
  assert.strictEqual(social.name, 'Social Reel');
});

test('syncPresetCatalog: inserts all rows when table is empty', async () => {
  const posts = [];
  const r = await syncPresetCatalog({
    sbGet: async () => [],
    sbPost: async (table, row) => {
      posts.push({ table, row });
    },
    sbPatch: async () => {},
  });
  assert.strictEqual(r.inserted, listPresetCatalog().length);
  assert.strictEqual(r.updated, 0);
  assert.ok(posts.every((p) => p.table === 'higgsfield_presets'));
  assert.ok(posts.every((p) => p.row.updated_at));
});

test('syncPresetCatalog: idempotent — no inserts when catalog already present + unchanged', async () => {
  const existing = listPresetCatalog().map((r) => ({
    preset_id: r.preset_id,
    name: r.name,
    description: r.description,
  }));
  let posted = 0;
  let patched = 0;
  const r = await syncPresetCatalog({
    sbGet: async () => existing,
    sbPost: async () => {
      posted += 1;
    },
    sbPatch: async () => {
      patched += 1;
    },
  });
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(r.updated, 0);
  assert.strictEqual(posted, 0);
  assert.strictEqual(patched, 0);
});

test('syncPresetCatalog: patches rows whose name/description drifted', async () => {
  const existing = listPresetCatalog().map((r) => ({
    preset_id: r.preset_id,
    name: 'STALE',
    description: r.description,
  }));
  const patches = [];
  const r = await syncPresetCatalog({
    sbGet: async () => existing,
    sbPost: async () => {},
    sbPatch: async (table, q, body) => {
      patches.push({ table, q, body });
    },
  });
  assert.strictEqual(r.inserted, 0);
  assert.strictEqual(r.updated, listPresetCatalog().length);
  assert.ok(patches[0].q.includes('preset_id=eq.'));
  assert.ok(patches[0].body.name !== 'STALE');
});

test('syncPresetCatalog: soft-skips when sb helpers unavailable', async () => {
  const r = await syncPresetCatalog({});
  assert.strictEqual(r.inserted, 0);
  assert.ok(r.skipped);
});

test('syncPresetCatalog: a single row write failure does not abort the rest', async () => {
  let calls = 0;
  const r = await syncPresetCatalog({
    sbGet: async () => [],
    sbPost: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient write error');
    },
    sbPatch: async () => {},
    logger: { warn() {} },
  });
  // First insert threw; the remaining presets still inserted.
  assert.strictEqual(r.inserted, listPresetCatalog().length - 1);
});
