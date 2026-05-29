'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Jimp = require('jimp');

const { compositeLogo, buildOverlayedImage } = require('../lib/logoOverlay');

// Build a solid-color PNG buffer in memory (no network, no fixtures).
async function solidPng(width, height, hex) {
  const img = await new Promise((resolve, reject) => {
    new Jimp(width, height, hex, (err, image) => (err ? reject(err) : resolve(image)));
  });
  return img.getBufferAsync(Jimp.MIME_PNG);
}

test('compositeLogo: returns a valid PNG with the base dimensions preserved', async () => {
  const base = await solidPng(800, 800, 0x3366ffff); // blue base
  const logo = await solidPng(200, 100, 0xff0000ff); // red logo
  const out = await compositeLogo(base, logo, { position: 'bottom-right', scale: 0.2, opacity: 1 });

  assert.ok(Buffer.isBuffer(out) && out.length > 0, 'returns a non-empty buffer');
  const result = await Jimp.read(out);
  assert.strictEqual(result.getWidth(), 800, 'base width preserved');
  assert.strictEqual(result.getHeight(), 800, 'base height preserved');
});

test('compositeLogo: logo pixels actually land in the chosen corner', async () => {
  const base = await solidPng(1000, 1000, 0x000000ff); // black base
  const logo = await solidPng(300, 300, 0xff0000ff); // red logo
  const out = await compositeLogo(base, logo, { position: 'bottom-right', scale: 0.2, marginRatio: 0.04, opacity: 1 });
  const result = await Jimp.read(out);

  // Bottom-right region should now contain red (logo); top-left stays black.
  const brPixel = Jimp.intToRGBA(result.getPixelColor(950, 950));
  const tlPixel = Jimp.intToRGBA(result.getPixelColor(20, 20));
  assert.ok(
    brPixel.r > 150 && brPixel.g < 80 && brPixel.b < 80,
    `bottom-right should be reddish, got ${JSON.stringify(brPixel)}`
  );
  assert.ok(
    tlPixel.r < 40 && tlPixel.g < 40 && tlPixel.b < 40,
    `top-left should stay black, got ${JSON.stringify(tlPixel)}`
  );
});

test('compositeLogo: top-left placement puts the logo top-left, not bottom-right', async () => {
  const base = await solidPng(1000, 1000, 0x000000ff);
  const logo = await solidPng(300, 300, 0x00ff00ff); // green
  const out = await compositeLogo(base, logo, { position: 'top-left', scale: 0.2, marginRatio: 0.04, opacity: 1 });
  const result = await Jimp.read(out);
  // Logo sits at the margin (~40px) with width ~200px → sample well inside it.
  const tlPixel = Jimp.intToRGBA(result.getPixelColor(100, 100));
  assert.ok(tlPixel.g > 150 && tlPixel.r < 80, `top-left should be greenish, got ${JSON.stringify(tlPixel)}`);
});

test('buildOverlayedImage: downloads both, composites, returns a buffer', async () => {
  const base = await solidPng(600, 600, 0x112233ff);
  const logo = await solidPng(120, 120, 0xffffffff);
  const fetchImpl = async (url) => ({
    ok: true,
    arrayBuffer: async () => (url.includes('logo') ? logo : base),
  });
  const r = await buildOverlayedImage({
    baseImageUrl: 'https://cdn/base.png',
    logoUrl: 'https://cdn/logo.png',
    deps: { fetchImpl },
  });
  assert.strictEqual(r.ok, true);
  const img = await Jimp.read(r.buffer);
  assert.strictEqual(img.getWidth(), 600);
});

test('buildOverlayedImage: soft-fails when a download is not ok', async () => {
  const fetchImpl = async () => ({ ok: false, arrayBuffer: async () => Buffer.alloc(0) });
  const r = await buildOverlayedImage({
    baseImageUrl: 'https://cdn/base.png',
    logoUrl: 'https://cdn/logo.png',
    deps: { fetchImpl },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'download_failed');
});

test('buildOverlayedImage: soft-fails on missing url', async () => {
  const r = await buildOverlayedImage({
    baseImageUrl: '',
    logoUrl: 'https://x',
    deps: { fetchImpl: async () => ({}) },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing_url');
});

test('buildOverlayedImage: soft-fails (no throw) when fetch rejects', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const r = await buildOverlayedImage({
    baseImageUrl: 'https://cdn/base.png',
    logoUrl: 'https://cdn/logo.png',
    deps: { fetchImpl, logger: { warn() {} } },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'composite_failed');
});
