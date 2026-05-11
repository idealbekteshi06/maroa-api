'use strict';

/**
 * tests/helpers/fakeAnthropic.js
 *
 * Drop-in replacement for server.js `callClaude`. Returns canned responses
 * keyed by skill name (`extra.skill`), the executor model, or the task
 * type. Records every call to a `.calls` array so tests can assert
 * exactly what was sent.
 *
 * Usage:
 *
 *   const { createFakeClaude } = require('./helpers/fakeAnthropic');
 *   const fake = createFakeClaude({
 *     responses: {
 *       'ad_optimizer_audit': () => JSON.stringify({ decision: 'scale', ... }),
 *       'cro_audit':           () => JSON.stringify({ audit_score: 78, ... }),
 *       _default:              () => JSON.stringify({ ok: true }),
 *     },
 *   });
 *
 *   await engine.auditOne({ callClaude: fake });
 *
 *   assert.strictEqual(fake.calls.length, 1);
 *   assert.strictEqual(fake.calls[0].extra.skill, 'ad_optimizer_audit');
 *
 * The fake supports BOTH callClaude signatures — positional
 * `(prompt, model, max, extra)` and object `({system, user, model, ...})`
 * — because production callers use both.
 *
 * Latency simulation: pass { latencyMs: 50 } to add artificial delay.
 * Failure injection: pass { failOn: ['skill_x'] } to make those calls
 * throw a fake 5xx, so retry paths get exercised.
 */

function createFakeClaude(opts = {}) {
  const {
    responses = {},
    latencyMs = 0,
    failOn = [],
    failHttpStatus = 500,
    usageDefault = { input_tokens: 100, output_tokens: 50 },
  } = opts;

  const calls = [];

  async function fakeCallClaude(...args) {
    // Detect the shape the caller used
    let prompt, model, maxTokens, extra;
    if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      const obj = args[0];
      prompt = obj.user;
      model = obj.model || obj.executor;
      maxTokens = obj.max_tokens || obj.maxTokens;
      extra = { ...(obj.extra || {}), system: obj.system };
    } else {
      [prompt, model, maxTokens, extra = {}] = args;
    }

    const skill = (extra && extra.skill) || null;
    const businessId = (extra && extra.businessId) || null;

    const callRecord = {
      prompt,
      model: model || 'claude-sonnet-4-5',
      maxTokens,
      extra: { ...extra },
      skill,
      businessId,
      timestamp: Date.now(),
    };
    calls.push(callRecord);

    if (latencyMs > 0) {
      await new Promise((r) => setTimeout(r, latencyMs));
    }

    // Failure injection
    if (skill && failOn.includes(skill)) {
      const err = new Error(`fakeAnthropic: simulated ${failHttpStatus} for skill=${skill}`);
      err.status = failHttpStatus;
      throw err;
    }

    // Resolve response — by skill, then by model, then default
    let body;
    const resolver = responses[skill] || responses[model] || responses._default;
    if (typeof resolver === 'function') {
      body = resolver({ prompt, model, maxTokens, extra, callRecord });
    } else if (typeof resolver === 'string') {
      body = resolver;
    } else if (resolver !== undefined) {
      body = JSON.stringify(resolver);
    } else {
      body = '{"ok": true}';
    }

    callRecord.responseText = body;
    callRecord.responseUsage = usageDefault;

    // Honor extra.returnRaw / extra.returnFullResponse like the real callClaude
    if (extra && extra.returnFullResponse) {
      return {
        content: [{ type: 'text', text: body }],
        usage: usageDefault,
      };
    }
    if (extra && extra.returnRaw) return body;
    // Default: callClaude returns extractJSON(body) || { _raw: body }
    try { return JSON.parse(body); }
    catch { return { _raw: body }; }
  }

  fakeCallClaude.calls = calls;
  fakeCallClaude.reset = () => { calls.length = 0; };
  fakeCallClaude.callCount = () => calls.length;
  fakeCallClaude.lastCall = () => calls[calls.length - 1] || null;
  fakeCallClaude.callsForSkill = (skill) => calls.filter((c) => c.skill === skill);

  return fakeCallClaude;
}

/** A simple extractJSON that the prompt modules expect alongside callClaude. */
function fakeExtractJSON(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/{[\s\S]*}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

module.exports = { createFakeClaude, fakeExtractJSON };
