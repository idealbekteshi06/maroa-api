'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { LIVE_FLAGS, describeLiveFlags, liveFlagsLogLine } = require('../lib/env');

test('LIVE_FLAGS lists the external-write gates', () => {
  assert.deepStrictEqual(
    [...LIVE_FLAGS].sort(),
    ['GOOGLE_ADS_LIVE', 'META_AD_LAUNCH_LIVE', 'META_PUBLISH_LIVE', 'TIKTOK_ADS_LIVE'].sort()
  );
});

test('describeLiveFlags reports each flag state from a passed env object', () => {
  const e = { META_AD_LAUNCH_LIVE: true, META_PUBLISH_LIVE: false, GOOGLE_ADS_LIVE: false, TIKTOK_ADS_LIVE: false };
  const states = describeLiveFlags(e);
  assert.strictEqual(states.length, 4);
  const meta = states.find((s) => s.key === 'META_AD_LAUNCH_LIVE');
  assert.strictEqual(meta.live, true);
  assert.ok(states.filter((s) => s.key !== 'META_AD_LAUNCH_LIVE').every((s) => s.live === false));
});

test('liveFlagsLogLine renders LIVE / DRY-RUN per flag', () => {
  const e = { META_AD_LAUNCH_LIVE: true, META_PUBLISH_LIVE: false, GOOGLE_ADS_LIVE: false, TIKTOK_ADS_LIVE: false };
  const line = liveFlagsLogLine(e);
  assert.match(line, /META_AD_LAUNCH_LIVE=LIVE/);
  assert.match(line, /META_PUBLISH_LIVE=DRY-RUN/);
  assert.match(line, /GOOGLE_ADS_LIVE=DRY-RUN/);
  assert.match(line, /TIKTOK_ADS_LIVE=DRY-RUN/);
});

test('flags default to DRY-RUN when env value is unset/non-true', () => {
  const e = {}; // nothing set
  for (const { live } of describeLiveFlags(e)) assert.strictEqual(live, false, 'unset flag must be dry-run');
});
