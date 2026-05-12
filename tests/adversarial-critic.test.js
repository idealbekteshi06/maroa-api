'use strict';

/**
 * tests/adversarial-critic.test.js
 *
 * Verifies lib/adversarialCritic.js — the Reflexion-style copywriter/critic/
 * rewriter pipeline. Stubs callClaude so tests are deterministic.
 */

const test = require('node:test');
const assert = require('node:assert');

const critic = require('../lib/adversarialCritic');
const metrics = require('../services/observability/metrics');

// ─── parseCriticOutput ──────────────────────────────────────────────────────

test('parseCriticOutput: parses well-formed pass verdict', () => {
  const out = critic.parseCriticOutput('{"severity":"pass","issues":[],"overall":"ship it"}');
  assert.strictEqual(out.severity, 'pass');
  assert.deepStrictEqual(out.issues, []);
  assert.strictEqual(out.overall, 'ship it');
});

test('parseCriticOutput: parses major verdict with issues', () => {
  const out = critic.parseCriticOutput(
    JSON.stringify({
      severity: 'major',
      issues: [{ span: 'the best', problem: 'vague claim', fix: '12,847 5-star reviews' }],
      overall: 'rewrite needed',
    })
  );
  assert.strictEqual(out.severity, 'major');
  assert.strictEqual(out.issues.length, 1);
  assert.strictEqual(out.issues[0].span, 'the best');
});

test('parseCriticOutput: strips markdown code fences', () => {
  const out = critic.parseCriticOutput('```json\n{"severity":"minor","issues":[],"overall":"x"}\n```');
  assert.strictEqual(out.severity, 'minor');
});

test('parseCriticOutput: extracts embedded JSON from prose', () => {
  const out = critic.parseCriticOutput('Here is my critique: {"severity":"minor","issues":[],"overall":""}');
  assert.strictEqual(out.severity, 'minor');
});

test('parseCriticOutput: returns malformed=true on garbage', () => {
  const out = critic.parseCriticOutput('not json at all');
  assert.strictEqual(out._malformed, true);
  assert.strictEqual(
    out.severity,
    'pass',
    'malformed must default to pass — never burn rewrite budget on a confused critic'
  );
});

test('parseCriticOutput: coerces "pass" + non-empty issues to "minor"', () => {
  const out = critic.parseCriticOutput(
    '{"severity":"pass","issues":[{"span":"x","problem":"y","fix":"z"}],"overall":""}'
  );
  assert.strictEqual(out.severity, 'minor', 'model contradicting itself should not skip rewrite');
});

test('parseCriticOutput: rejects unknown severity, defaults to pass', () => {
  const out = critic.parseCriticOutput('{"severity":"catastrophic","issues":[],"overall":""}');
  assert.strictEqual(out.severity, 'pass');
});

test('parseCriticOutput: returns pass on null/empty input', () => {
  assert.strictEqual(critic.parseCriticOutput('').severity, 'pass');
  assert.strictEqual(critic.parseCriticOutput(null).severity, 'pass');
});

// ─── buildCriticSystemPrompt ────────────────────────────────────────────────

test('buildCriticSystemPrompt: includes role-specific bad patterns', () => {
  const adPrompt = critic.buildCriticSystemPrompt('ad_copy');
  assert.match(adPrompt, /creative director/i);
  assert.match(adPrompt, /clichés|hooks|CTA/i);

  const emailPrompt = critic.buildCriticSystemPrompt('email');
  assert.match(emailPrompt, /direct-response email/i);
  assert.match(emailPrompt, /subject line/i);
});

test('buildCriticSystemPrompt: unknown role falls back to generic', () => {
  const prompt = critic.buildCriticSystemPrompt('not_a_real_role');
  assert.match(prompt, /senior marketing reviewer/i);
});

test('buildCriticSystemPrompt: injects extra criteria when provided', () => {
  const prompt = critic.buildCriticSystemPrompt('ad_copy', 'Must mention Tirana');
  assert.match(prompt, /Must mention Tirana/);
});

test('buildCriticSystemPrompt: enforces JSON-only output discipline', () => {
  const prompt = critic.buildCriticSystemPrompt('ad_copy');
  assert.match(prompt, /Output ONLY this JSON/i);
  assert.match(prompt, /no markdown fences/i);
});

// ─── critique() ────────────────────────────────────────────────────────────

test('critique: returns pass when draft empty without calling Claude', async () => {
  let called = false;
  const fakeClaude = async () => {
    called = true;
    return '';
  };
  const out = await critic.critique({ callClaude: fakeClaude, draft: '', role: 'ad_copy' });
  assert.strictEqual(called, false, 'empty draft must short-circuit, not waste a Claude call');
  assert.strictEqual(out.severity, 'pass');
});

test('critique: throws when callClaude not injected', async () => {
  await assert.rejects(critic.critique({ draft: 'x', role: 'ad_copy' }), /callClaude required/);
});

test('critique: passes role + extra criteria through to Claude', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return '{"severity":"pass","issues":[],"overall":""}';
  };
  await critic.critique({
    callClaude: fakeClaude,
    draft: 'Buy our amazing product',
    role: 'ad_copy',
    extraCriteria: 'Must be Albanian-language',
    businessId: 'biz1',
  });
  assert.strictEqual(captured.length, 1);
  assert.match(captured[0].system, /creative director/i);
  assert.match(captured[0].system, /Albanian-language/);
  assert.match(captured[0].user, /amazing product/);
  assert.strictEqual(captured[0].extra.businessId, 'biz1');
  assert.strictEqual(captured[0].extra.skipBrandVoice, true, 'critic must not be brand-voice-anchored');
});

test('critique: defaults to Haiku for cost discipline', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return '{"severity":"pass","issues":[],"overall":""}';
  };
  await critic.critique({ callClaude: fakeClaude, draft: 'x', role: 'ad_copy' });
  assert.match(captured[0].model, /haiku/);
});

// ─── rewrite() ──────────────────────────────────────────────────────────────

test('rewrite: returns original when called with empty original', async () => {
  let called = false;
  const fakeClaude = async () => {
    called = true;
    return 'rewritten';
  };
  const out = await critic.rewrite({
    callClaude: fakeClaude,
    original: '',
    criticVerdict: { severity: 'major', issues: [] },
  });
  assert.strictEqual(out, '');
  assert.strictEqual(called, false);
});

test('rewrite: feeds critic spans + fixes to Claude in structured form', async () => {
  const captured = [];
  const fakeClaude = async (args) => {
    captured.push(args);
    return 'New version that is much better';
  };
  await critic.rewrite({
    callClaude: fakeClaude,
    original: 'Buy our amazing product',
    criticVerdict: {
      severity: 'minor',
      issues: [{ span: 'amazing', problem: 'vague', fix: 'specific benefit' }],
      overall: 'too generic',
    },
    role: 'ad_copy',
  });
  assert.match(captured[0].user, /ORIGINAL:/);
  assert.match(captured[0].user, /CRITIQUE/);
  assert.match(captured[0].user, /amazing/);
  assert.match(captured[0].user, /specific benefit/);
});

test('rewrite: strips surrounding quotes the model sometimes adds', async () => {
  const fakeClaude = async () => '"Clean output"';
  const out = await critic.rewrite({
    callClaude: fakeClaude,
    original: 'orig',
    criticVerdict: { severity: 'minor', issues: [] },
  });
  assert.strictEqual(out, 'Clean output');
});

// ─── reflexion() — the full orchestrator ────────────────────────────────────

test('reflexion: pass verdict returns original unchanged + no rewrite call', async () => {
  metrics.reset();
  let claudeCalls = 0;
  const fakeClaude = async (args) => {
    claudeCalls++;
    if (args.system?.includes('critiquing')) {
      return '{"severity":"pass","issues":[],"overall":"ship it"}';
    }
    throw new Error('Should not have called rewriter on pass');
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'Get 12,847 customers like we did',
    role: 'ad_copy',
    metrics,
  });
  assert.strictEqual(result.final, 'Get 12,847 customers like we did');
  assert.strictEqual(result.improved, false);
  assert.strictEqual(result.rounds.length, 1);
  assert.strictEqual(result.criticVerdict.severity, 'pass');
  assert.strictEqual(claudeCalls, 1, 'pass verdict must skip the rewrite call entirely');
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some((k) => k.includes('critic_kept_original_total')));
});

test('reflexion: major verdict triggers rewrite + returns new version', async () => {
  metrics.reset();
  const fakeClaude = async (args) => {
    if (args.system?.includes('critiquing')) {
      return JSON.stringify({
        severity: 'major',
        issues: [{ span: 'the best', problem: 'vague', fix: 'specific number' }],
        overall: 'rewrite',
      });
    }
    return 'Trusted by 12,847 cafés in Albania';
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'We are the best cafe',
    role: 'ad_copy',
    maxRewriteRounds: 1,
    metrics,
  });
  assert.strictEqual(result.final, 'Trusted by 12,847 cafés in Albania');
  assert.strictEqual(result.improved, true);
  // Should run 2 rounds: round 0 (major → rewrite) then round 1 (re-critique).
  assert.ok(result.rounds.length >= 1);
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some((k) => k.includes('critic_rewrite_applied_total')));
});

test('reflexion: maxRewriteRounds=0 means critique only, never rewrite', async () => {
  let rewriteCount = 0;
  const fakeClaude = async (args) => {
    if (args.system?.includes('critiquing')) {
      return '{"severity":"major","issues":[],"overall":"bad"}';
    }
    rewriteCount++;
    return 'rewritten';
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'original',
    role: 'ad_copy',
    maxRewriteRounds: 0,
  });
  assert.strictEqual(result.final, 'original');
  assert.strictEqual(result.improved, false);
  assert.strictEqual(rewriteCount, 0);
});

test('reflexion: accepts draftFn thunk and defers expensive draft generation', async () => {
  let thunkCalled = false;
  const draftFn = async () => {
    thunkCalled = true;
    return 'deferred draft';
  };
  const fakeClaude = async () => '{"severity":"pass","issues":[],"overall":""}';
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draftFn,
    role: 'ad_copy',
  });
  assert.strictEqual(thunkCalled, true);
  assert.strictEqual(result.final, 'deferred draft');
});

test('reflexion: throws when neither draft nor draftFn provided', async () => {
  await assert.rejects(critic.reflexion({ callClaude: async () => '', role: 'ad_copy' }), /draft or draftFn required/);
});

test('reflexion: empty draft returns empty without burning critic call', async () => {
  let claudeCalls = 0;
  const fakeClaude = async () => {
    claudeCalls++;
    return '';
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: '',
    role: 'ad_copy',
  });
  assert.strictEqual(result.final, '');
  assert.strictEqual(claudeCalls, 0);
});

test('reflexion: malformed critic JSON ships the draft (fail safe)', async () => {
  const fakeClaude = async (args) => {
    if (args.system?.includes('critiquing')) return 'just some prose, not json';
    return 'rewritten';
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'original',
    role: 'ad_copy',
  });
  assert.strictEqual(result.final, 'original', 'malformed critic must not corrupt the draft');
  assert.strictEqual(result.improved, false);
});

test('reflexion: emits telemetry counters with role + severity labels', async () => {
  metrics.reset();
  const fakeClaude = async (args) => {
    if (args.system?.includes('critiquing')) return '{"severity":"pass","issues":[],"overall":""}';
    return '';
  };
  await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'good draft',
    role: 'email',
    metrics,
  });
  const snap = metrics.snapshot();
  const keys = Object.keys(snap.counters);
  assert.ok(keys.some((k) => k.startsWith('critic_runs_total') && k.includes('role="email"')));
  assert.ok(keys.some((k) => k.startsWith('critic_runs_total') && k.includes('severity="pass"')));
});

test('reflexion: rewriter returning identical text aborts without infinite loop', async () => {
  let criticCalls = 0;
  const fakeClaude = async (args) => {
    if (args.system?.includes('critiquing')) {
      criticCalls++;
      return '{"severity":"major","issues":[],"overall":"bad"}';
    }
    return 'original'; // rewriter returns the same text
  };
  const result = await critic.reflexion({
    callClaude: fakeClaude,
    draft: 'original',
    role: 'ad_copy',
    maxRewriteRounds: 3,
  });
  assert.strictEqual(result.final, 'original');
  // Must not loop forever — should break after first identical rewrite
  assert.strictEqual(criticCalls, 1);
});
