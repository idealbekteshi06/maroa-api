'use strict';

/**
 * tests/helpers/fakeInngest.js
 *
 * Synchronous Inngest function driver. Wraps the `step` argument an
 * Inngest handler receives so tests can:
 *
 *   - call the handler directly (no real Inngest runtime needed)
 *   - assert every step.run() invocation by name + result
 *   - fast-forward step.sleep() (no real 24h waits in tests)
 *   - inject failures into specific steps to exercise retry logic
 *
 * Usage:
 *
 *   const { runFunction } = require('./helpers/fakeInngest');
 *   const fn = require('../services/inngest/functions').contentPublishFeedback24h;
 *
 *   const result = await runFunction(fn, {
 *     event: { data: { contentId: 'c1', businessId: 'b1' } },
 *     stepResponses: { 'fetch-and-score': { ok: true, score: 8 } },
 *   });
 *
 *   assert.deepStrictEqual(result.stepsRun, ['wait-24h', 'fetch-and-score']);
 *   assert.deepStrictEqual(result.return, { ok: true, contentId: 'c1', ... });
 */

async function runFunction(fnObj, opts = {}) {
  const {
    event = { data: {} },
    stepResponses = {}, // name → value or fn(args) returning value
    failOn = [], // names of steps that should throw
    sleepShouldDelay = false,
  } = opts;

  const stepsRun = [];

  const step = {
    async run(name, work) {
      stepsRun.push(name);
      if (failOn.includes(name)) {
        const err = new Error(`fakeInngest: simulated failure in step "${name}"`);
        err.step = name;
        throw err;
      }
      if (stepResponses[name] !== undefined) {
        const r = stepResponses[name];
        return typeof r === 'function' ? r() : r;
      }
      // Otherwise actually execute the work (so simple deterministic steps
      // still run their bodies — useful for ad-hoc tests).
      return await work();
    },
    async sleep(name, duration) {
      stepsRun.push(`sleep:${name}:${duration}`);
      if (sleepShouldDelay) {
        // Convert "1d" / "60s" / "5m" to ms — best-effort, used only when
        // a test actually wants the real delay.
        const m = String(duration).match(/^(\d+)(s|m|h|d)$/);
        if (m) {
          const n = Number(m[1]);
          const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
          await new Promise((r) => setTimeout(r, n * unit));
        }
      }
      return null;
    },
    async sleepUntil(name, when) {
      stepsRun.push(`sleepUntil:${name}:${when}`);
      return null;
    },
    async waitForEvent(name) {
      stepsRun.push(`waitForEvent:${name}`);
      return null;
    },
    async sendEvent(name, payload) {
      stepsRun.push(`sendEvent:${name}`);
      return { ids: [], payload };
    },
  };

  let result, error;
  try {
    result = await fnObj.fn({ event, step });
  } catch (e) {
    error = e;
  }

  return { return: result, error, stepsRun };
}

/**
 * Drive ALL registered Inngest functions sequentially (smoke harness).
 * Useful for the kind of test that asserts "no function throws when
 * fed a representative event payload."
 */
async function smokeAll(functions, eventFactory) {
  const results = [];
  for (const fn of functions) {
    const id = fn?.id || fn?.opts?.id || fn?.name;
    const event = eventFactory ? eventFactory(id) : { data: {} };
    try {
      const r = await runFunction(fn, { event });
      results.push({ id, ok: !r.error, ...r });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { runFunction, smokeAll };
