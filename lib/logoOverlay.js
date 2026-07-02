'use strict';

/**
 * lib/logoOverlay.js
 * ---------------------------------------------------------------------------
 * Pixel-accurate logo compositing for generated images. Higgsfield can take a
 * logo as a *reference* (style hint) but cannot guarantee the exact logo lands
 * on the output — so for real brand placement we overlay the logo PNG onto the
 * generated image after generation.
 *
 * Pure-JS (jimp@1, no native build). The compositing core works on Buffers
 * and is fully unit-testable offline; the URL orchestration downloads both
 * images and soft-fails (returns { ok:false }) on any error so the caller can
 * fall back to the un-overlaid image.
 *
 * Default placement: bottom-right, logo scaled to ~18% of the base width, with
 * a margin proportional to the base — a safe, unobtrusive watermark position.
 * ---------------------------------------------------------------------------
 */

const { Jimp, JimpMime, BlendMode } = require('jimp');

const DEFAULT_OPTS = Object.freeze({
  position: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
  scale: 0.18, // logo width as a fraction of the base image width
  marginRatio: 0.04, // margin as a fraction of base width
  opacity: 0.9,
});

function placement(position, baseW, baseH, logoW, logoH, margin) {
  switch (position) {
    case 'bottom-left':
      return { x: margin, y: baseH - logoH - margin };
    case 'top-right':
      return { x: baseW - logoW - margin, y: margin };
    case 'top-left':
      return { x: margin, y: margin };
    case 'bottom-right':
    default:
      return { x: baseW - logoW - margin, y: baseH - logoH - margin };
  }
}

/**
 * Composite a logo onto a base image. Both inputs are Buffers; returns a PNG
 * Buffer. Throws only on genuinely unreadable input (callers wrap it).
 */
async function compositeLogo(baseBuffer, logoBuffer, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const base = await Jimp.read(baseBuffer);
  const logo = await Jimp.read(logoBuffer);

  const baseW = base.width;
  const baseH = base.height;
  const targetLogoW = Math.max(1, Math.round(baseW * o.scale));
  logo.resize({ w: targetLogoW }); // height auto-derived, preserves aspect
  if (o.opacity < 1) logo.opacity(o.opacity);

  const margin = Math.round(baseW * o.marginRatio);
  const { x, y } = placement(o.position, baseW, baseH, logo.width, logo.height, margin);

  base.composite(logo, x, y, {
    mode: BlendMode.SRC_OVER,
    opacitySource: 1,
    opacityDest: 1,
  });
  return base.getBuffer(JimpMime.png);
}

/**
 * Download base + logo by URL and composite. Soft-fails.
 * @returns {Promise<{ok:boolean, buffer?:Buffer, reason?:string}>}
 */
async function buildOverlayedImage({ baseImageUrl, logoUrl, deps = {} }) {
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const logger = deps.logger;
  if (!fetchImpl) return { ok: false, reason: 'no_fetch' };
  if (!baseImageUrl || !logoUrl) return { ok: false, reason: 'missing_url' };

  try {
    const [baseRes, logoRes] = await Promise.all([
      fetchImpl(baseImageUrl, { signal: AbortSignal.timeout(15000) }),
      fetchImpl(logoUrl, { signal: AbortSignal.timeout(15000) }),
    ]);
    if (!baseRes.ok || !logoRes.ok) return { ok: false, reason: 'download_failed' };
    const baseBuf = Buffer.from(await baseRes.arrayBuffer());
    const logoBuf = Buffer.from(await logoRes.arrayBuffer());
    const out = await compositeLogo(baseBuf, logoBuf, deps.opts || {});
    return { ok: true, buffer: out };
  } catch (e) {
    logger?.warn?.('logoOverlay', null, 'overlay failed', { error: e.message });
    return { ok: false, reason: 'composite_failed', error: e.message };
  }
}

module.exports = { compositeLogo, buildOverlayedImage, DEFAULT_OPTS };
