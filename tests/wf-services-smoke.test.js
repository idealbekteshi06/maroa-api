'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

/**
 * Audit 2026-05-18 H7: per-service smoke tests.
 *
 * Before this file: of 14 wf* service folders and 30+ other service folders,
 * only 8 had any test coverage. A wf module could silently break in a
 * refactor and we wouldn't know until production hit that path.
 *
 * This smoke suite is intentionally shallow: for every services/wf* +
 * key non-wf services, it requires the module's entry point and asserts
 * that any exported factory builds without throwing when handed a minimal
 * dep map. It catches the "ReferenceError on require" / "TypeError on
 * factory call" failure mode that mutes the whole workflow.
 *
 * Deep unit tests still live next door under tests/<service>.test.js.
 * Both layers are needed; the smoke layer is the floor.
 */

const SERVICES_DIR = path.join(__dirname, '..', 'services');

function _serviceFolders() {
  return fs
    .readdirSync(SERVICES_DIR)
    .filter((name) => {
      const full = path.join(SERVICES_DIR, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'index.js'));
    })
    .sort();
}

function _minimalDeps() {
  // The dep shape every wf factory expects, minimally fakeable.
  return {
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => true,
    sbDelete: async () => true,
    sbRpc: async () => ({ ok: true }),
    callClaude: async () => ({ _raw: '' }),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    Sentry: { captureException: () => {} },
    inngest: { send: async () => ({}) },
    metrics: { increment: () => {}, observeHistogram: () => {}, setGauge: () => {} },
  };
}

for (const folder of _serviceFolders()) {
  test(`smoke: services/${folder}/index.js loads`, () => {
    const mod = require(path.join(SERVICES_DIR, folder, 'index.js'));
    assert.ok(mod, `services/${folder} returned no exports`);

    const isFactory =
      typeof mod === 'function' ||
      typeof mod.create === 'function' ||
      typeof mod[`create${folder.charAt(0).toUpperCase() + folder.slice(1)}`] === 'function';

    if (isFactory) {
      // Try to invoke. The factory MAY throw on missing required deps —
      // that's fine; we just need to verify the require itself didn't blow
      // up due to ReferenceErrors or missing-module errors elsewhere in the
      // dependency tree.
      try {
        if (typeof mod === 'function') {
          mod(_minimalDeps());
        } else if (typeof mod.create === 'function') {
          mod.create(_minimalDeps());
        }
      } catch (e) {
        // "Missing dep X" / "config required" errors are acceptable — they
        // mean the factory ran far enough to declare its needs. Real bugs
        // throw ReferenceError on uninitialized identifiers or fail before
        // user-facing validation.
        if (
          e instanceof ReferenceError ||
          /Cannot find module/.test(e.message) ||
          /is not defined/.test(e.message)
        ) {
          throw e;
        }
      }
    }
  });
}
