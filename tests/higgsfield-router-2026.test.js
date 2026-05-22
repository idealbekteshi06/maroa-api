'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeModelForContentType, resolveModelSlug } = require('../services/higgsfield/modelRouter');
const { getCameraPreset, motionPromptFromPreset } = require('../services/higgsfield/cameraPresets');
const { estimateModelCost } = require('../services/higgsfield/costTracking');
const createHiggsfield = require('../services/higgsfield');

test('modelRouter: ugc_testimonial → wan 2.5', () => {
  const r = routeModelForContentType('ugc_testimonial');
  assert.strictEqual(r.model_slug, 'wan-2.5');
  assert.strictEqual(r.model, 'wan 2.5');
});

test('modelRouter: cinematic → kling 3.0', () => {
  const r = routeModelForContentType('cinematic');
  assert.strictEqual(r.model_slug, 'kling-3.0');
  assert.strictEqual(r.model, 'kling 3.0');
});

test('modelRouter: social_reel → nano banana pro', () => {
  const r = routeModelForContentType('social_reel');
  assert.strictEqual(r.model_slug, 'nano-banana-pro');
  assert.strictEqual(r.model, 'nano banana pro');
});

test('modelRouter: default → nano-banana-pro', () => {
  const r = routeModelForContentType(undefined);
  assert.strictEqual(r.model_slug, 'nano-banana-pro');
});

test('modelRouter: sora-2 migrates to kling-3.0', () => {
  const warnings = [];
  const r = resolveModelSlug('sora-2', (m) => warnings.push(m));
  assert.strictEqual(r.modelSlug, 'kling-3.0');
  assert.strictEqual(r.canonical, 'kling 3.0');
  assert.ok(warnings.some((w) => w.includes('Sept 24 2026')));
});

test('cameraPresets: social is vertical', () => {
  const p = getCameraPreset('social');
  assert.strictEqual(p.aspect_ratio, '9:16');
  assert.match(p.camera, /handheld/i);
});

test('costTracking: kling-3.0 credits', () => {
  const est = estimateModelCost('kling-3.0');
  assert.strictEqual(est.credits, 6);
  assert.strictEqual(est.cost_usd, 0.06);
});

test('higgsfield service exports routeModelForContentType + generateVideo', () => {
  const svc = createHiggsfield({
    sbGet: async () => [],
    sbPost: async () => {},
    extractJSON: () => ({}),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  assert.strictEqual(typeof svc.routeModelForContentType, 'function');
  assert.strictEqual(typeof svc.generateImage, 'function');
  assert.strictEqual(typeof svc.generateVideo, 'function');
  const routed = svc.routeModelForContentType('product_video');
  assert.strictEqual(routed.model, 'kling 3.0');
});
