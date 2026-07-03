'use strict';

const test = require('node:test');
const assert = require('node:assert');
const createMarketingStudio = require('../services/higgsfield/marketingStudio');

const BIZ = '11111111-1111-4111-8111-111111111111';

function makeDeps(overrides = {}) {
  const calls = { posts: [], gets: [], patches: [] };
  const deps = {
    hfPost: async (path, body) => {
      calls.posts.push({ path, body });
      return { status: 200, body: { id: 'kit_1', url: 'https://cdn/img.png' } };
    },
    hfGet: async (path) => {
      calls.gets.push({ path });
      return { status: 200, body: { items: [{ id: 'style_1' }] } };
    },
    sbGet: async () => [
      {
        id: BIZ,
        business_name: 'Test Biz',
        logo_url: 'https://cdn/logo.png',
        product_image_urls: ['https://cdn/p1.png'],
        higgsfield_brand_kit_id: null,
      },
    ],
    sbPatch: async (table, filter, patch) => {
      calls.patches.push({ table, filter, patch });
      return {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
  return { deps, calls };
}

test('ensureBrandKit: creates a kit from business assets and persists the id', async () => {
  const { deps, calls } = makeDeps();
  const ms = createMarketingStudio(deps);
  const kitId = await ms.ensureBrandKit({ businessId: BIZ });
  assert.strictEqual(kitId, 'kit_1');
  assert.strictEqual(calls.posts[0].body.logo_url, 'https://cdn/logo.png');
  assert.strictEqual(calls.patches[0].patch.higgsfield_brand_kit_id, 'kit_1');
});

test('ensureBrandKit: returns existing id without an API call', async () => {
  const { deps, calls } = makeDeps({
    sbGet: async () => [{ id: BIZ, higgsfield_brand_kit_id: 'kit_existing' }],
  });
  const ms = createMarketingStudio(deps);
  assert.strictEqual(await ms.ensureBrandKit({ businessId: BIZ }), 'kit_existing');
  assert.strictEqual(calls.posts.length, 0);
});

test('ensureBrandKit: 404 (endpoint not enabled) degrades to null, never throws', async () => {
  const { deps } = makeDeps({ hfPost: async () => ({ status: 404, body: {} }) });
  const ms = createMarketingStudio(deps);
  assert.strictEqual(await ms.ensureBrandKit({ businessId: BIZ }), null);
});

test('generateDtcAdImage: requires styleId; includes brand kit + clamps batch', async () => {
  const { deps, calls } = makeDeps();
  const ms = createMarketingStudio({
    ...deps,
    submitImageAndWait: async (payload) => {
      calls.posts.push({ path: 'submit', body: payload });
      return 'https://cdn/ad.png';
    },
  });

  const noStyle = await ms.generateDtcAdImage({ businessId: BIZ, prompt: 'x' });
  assert.strictEqual(noStyle.ok, false);
  assert.strictEqual(noStyle.reason, 'ms_image_style_required');

  const r = await ms.generateDtcAdImage({ businessId: BIZ, prompt: 'ad', styleId: 'style_1', batchSize: 99 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.imageUrl, 'https://cdn/ad.png');
  const submitted = calls.posts.find((c) => c.path === 'submit').body;
  assert.strictEqual(submitted.style_id, 'style_1');
  assert.strictEqual(submitted.brand_kit_id, 'kit_1', 'brand kit auto-resolved from business');
  assert.strictEqual(submitted.batch_size, 20, 'batch clamped to API max');
});

test('generateMarketingVideo: ad_reference_id excludes hook/setting (API contract)', async () => {
  const { deps } = makeDeps();
  let submitted;
  const ms = createMarketingStudio({
    ...deps,
    submitVideoAndWait: async (_path, payload) => {
      submitted = payload;
      return 'https://cdn/vid.mp4';
    },
  });
  const r = await ms.generateMarketingVideo({
    businessId: BIZ,
    prompt: 'p',
    adReferenceId: 'ref_1',
    hookId: 'hook_1',
    settingId: 'set_1',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(submitted.ad_reference_id, 'ref_1');
  assert.strictEqual(submitted.hook_id, undefined, 'hook dropped when ad_reference drives the scenario');
  assert.strictEqual(submitted.setting_id, undefined);
});

test('recreateAdForBusiness: chains ad-reference creation into generation', async () => {
  const { deps } = makeDeps({
    hfPost: async (path) =>
      path.includes('ad-references') ? { status: 200, body: { id: 'ref_9' } } : { status: 200, body: {} },
  });
  let videoPayload;
  const ms = createMarketingStudio({
    ...deps,
    submitVideoAndWait: async (_path, payload) => {
      videoPayload = payload;
      return 'https://cdn/recreated.mp4';
    },
  });
  const r = await ms.recreateAdForBusiness({
    businessId: BIZ,
    referenceVideoUrl: 'https://ads.example/winner.mp4',
    imageUrls: ['https://cdn/myproduct.png'],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.videoUrl, 'https://cdn/recreated.mp4');
  assert.strictEqual(videoPayload.ad_reference_id, 'ref_9');
  assert.deepStrictEqual(videoPayload.medias, [{ type: 'image', url: 'https://cdn/myproduct.png' }]);
});

test('recreateAdForBusiness: degraded reference creation short-circuits', async () => {
  const { deps } = makeDeps({ hfPost: async () => ({ status: 404, body: {} }) });
  const ms = createMarketingStudio({ ...deps, submitVideoAndWait: async () => 'never' });
  const r = await ms.recreateAdForBusiness({ businessId: BIZ, referenceVideoUrl: 'https://x/y.mp4' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ad_references_endpoint_pending');
});

test('listImageStyles/listVideoPresets: degrade with empty arrays on 404', async () => {
  const { deps } = makeDeps({ hfGet: async () => ({ status: 404, body: {} }) });
  const ms = createMarketingStudio(deps);
  const styles = await ms.listImageStyles();
  assert.strictEqual(styles.ok, false);
  assert.deepStrictEqual(styles.styles, []);
  const presets = await ms.listVideoPresets();
  assert.strictEqual(presets.ok, false);
  assert.deepStrictEqual(presets.presets, []);
});
