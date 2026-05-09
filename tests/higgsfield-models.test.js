'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Build a service instance with stub deps. We're only testing the pure
// dispatcher functions (pathForModel + modelForCapability), so the rest
// of deps can be no-ops.
const createHiggsfield = require('../services/higgsfield');

function makeService(envOverrides = {}) {
  const prevEnv = {};
  for (const k of Object.keys(envOverrides)) {
    prevEnv[k] = process.env[k];
    process.env[k] = envOverrides[k];
  }
  const svc = createHiggsfield({
    sbGet: async () => [],
    sbPost: async () => {},
    sbPatch: async () => {},
    callClaude: async () => ({ content: [{ text: '{}' }] }),
    extractJSON: () => ({}),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  // restore
  for (const k of Object.keys(prevEnv)) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  return svc;
}

// ─── modelForCapability ────────────────────────────────────────────────────

test('higgsfield: modelForCapability picks Sora 2 for short reels', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('short_reel'), 'sora 2');
});

test('higgsfield: modelForCapability picks Kling 3.0 for reels needing audio', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('short_reel_with_audio'), 'kling 3.0');
});

test('higgsfield: modelForCapability picks Veo 3.1 for hero landing video', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('hero_landing_video'), 'veo 3.1');
});

test('higgsfield: modelForCapability picks Nano Banana Pro for product photos', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('product_photo_4k'), 'nano banana pro');
});

test('higgsfield: modelForCapability picks Soul 2.0 for founder portraits', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('founder_portrait'), 'soul 2.0');
});

test('higgsfield: modelForCapability picks Vibe Motion for kinetic typography', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('kinetic_typography'), 'vibe motion');
});

test('higgsfield: modelForCapability picks Cinema Studio 3.5 for multi-shot work', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('multi_shot_cinematic'), 'cinema studio 3.5');
});

test('higgsfield: modelForCapability picks Flux Kontext for before/after edits', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('before_after'), 'flux kontext');
});

test('higgsfield: modelForCapability defaults to Soul 2.0 on unknown capability', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('nonexistent_capability'), 'soul 2.0');
  assert.strictEqual(svc.modelForCapability(undefined), 'soul 2.0');
  assert.strictEqual(svc.modelForCapability(null), 'soul 2.0');
});

test('higgsfield: modelForCapability is case-insensitive', () => {
  const svc = makeService();
  assert.strictEqual(svc.modelForCapability('SHORT_REEL'), 'sora 2');
  assert.strictEqual(svc.modelForCapability('Short_Reel'), 'sora 2');
});

// ─── pathForModel — verify Cinema Studio 3.5 + Vibe Motion routes ──────────

test('higgsfield: pathForModel includes Cinema Studio 3.5', () => {
  const svc = makeService();
  const cinemaPath = svc.pathForModel('cinema studio 3.5');
  assert.ok(cinemaPath.includes('cinema-studio'), `cinema path looked wrong: ${cinemaPath}`);
});

test('higgsfield: pathForModel includes Vibe Motion', () => {
  const svc = makeService();
  const vibePath = svc.pathForModel('vibe motion');
  assert.ok(vibePath.includes('vibe-motion'), `vibe path looked wrong: ${vibePath}`);
});

test('higgsfield: pathForModel includes Sora 2', () => {
  const svc = makeService();
  const soraPath = svc.pathForModel('sora 2');
  assert.ok(soraPath.includes('sora'), `sora path looked wrong: ${soraPath}`);
});

test('higgsfield: pathForModel includes Veo 3.1', () => {
  const svc = makeService();
  const veoPath = svc.pathForModel('veo 3.1');
  assert.ok(veoPath.includes('veo'), `veo path looked wrong: ${veoPath}`);
});

test('higgsfield: pathForModel includes Kling 3.0 (NOT 2.6)', () => {
  const svc = makeService();
  const klingPath = svc.pathForModel('kling 3.0');
  assert.ok(klingPath.includes('v3'), `kling path should be v3: ${klingPath}`);
});

test('higgsfield: pathForModel includes Wan 2.7', () => {
  const svc = makeService();
  const wanPath = svc.pathForModel('wan 2.7');
  assert.ok(wanPath.includes('wan'), `wan path looked wrong: ${wanPath}`);
});

test('higgsfield: pathForModel includes Nano Banana Pro (separate from v2)', () => {
  const svc = makeService();
  const proPath = svc.pathForModel('nano banana pro');
  const v2Path = svc.pathForModel('nano banana 2');
  // They should resolve to different default endpoints
  assert.notStrictEqual(proPath, v2Path, 'Pro and v2 should not collapse to the same path');
});

// ─── env override hatch — env vars should win over defaults ────────────────

test('higgsfield: HIGGSFIELD_PATH_VIBE_MOTION env override is respected', () => {
  const svc = makeService({ HIGGSFIELD_PATH_VIBE_MOTION: '/custom/vibe' });
  const path = svc.pathForModel('vibe motion');
  assert.strictEqual(path, '/custom/vibe');
});

test('higgsfield: HIGGSFIELD_PATH_CINEMA env override is respected', () => {
  const svc = makeService({ HIGGSFIELD_PATH_CINEMA: '/custom/cinema/v4' });
  const path = svc.pathForModel('cinema studio');
  assert.strictEqual(path, '/custom/cinema/v4');
});

// ─── Soul ID training contract (verified vs CLI 0.1.34) ────────────────────

test('trainSoulCharacter: rejects fewer than 5 reference images (Higgsfield minimum)', async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.trainSoulCharacter({
      characterId: 'x',
      sourceImageUrls: ['https://1', 'https://2', 'https://3'],
      name: 'test',
    }),
    /5.20 reference images/i
  );
});

test('trainSoulCharacter: rejects more than 20 reference images (Higgsfield maximum)', async () => {
  const svc = makeService();
  const tooMany = [];
  for (let i = 0; i < 21; i += 1) tooMany.push(`https://${i}`);
  await assert.rejects(
    () => svc.trainSoulCharacter({ characterId: 'x', sourceImageUrls: tooMany, name: 'test' }),
    /5.20 reference images/i
  );
});

test('trainSoulCharacter: rejects unknown model selector', async () => {
  const svc = makeService();
  const five = ['https://1', 'https://2', 'https://3', 'https://4', 'https://5'];
  await assert.rejects(
    () => svc.trainSoulCharacter({
      characterId: 'x',
      sourceImageUrls: five,
      name: 'test',
      model: 'soul_3',  // doesn't exist
    }),
    /soul_2.*soul_cinematic/i
  );
});

test('higgsfield: uploadImageToHiggsfield is exported', () => {
  const svc = makeService();
  assert.strictEqual(typeof svc.uploadImageToHiggsfield, 'function');
});

test('higgsfield: waitForSoulIdTraining is exported', () => {
  const svc = makeService();
  assert.strictEqual(typeof svc.waitForSoulIdTraining, 'function');
});
