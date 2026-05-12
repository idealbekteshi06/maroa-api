'use strict';

/**
 * tests/nbest-reranker.test.js
 *
 * Verifies lib/nBestReranker.js — N-best generation + LLM-as-judge.
 */

const test = require('node:test');
const assert = require('node:assert');

const rr = require('../lib/nBestReranker');
const metrics = require('../services/observability/metrics');

// ─── parseJudgeOutput ───────────────────────────────────────────────────────

test('parseJudgeOutput: parses well-formed rankings', () => {
  const out = rr.parseJudgeOutput(
    JSON.stringify({
      rankings: [
        { index: 0, score: 92, rationale: 'specific + strong hook' },
        { index: 1, score: 71, rationale: 'okay but generic' },
      ],
    }),
    2
  );
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].index, 0);
  assert.strictEqual(out[0].score, 92);
});

test('parseJudgeOutput: returns null on garbage', () => {
  assert.strictEqual(rr.parseJudgeOutput('not json', 2), null);
  assert.strictEqual(rr.parseJudgeOutput(null, 2), null);
  assert.strictEqual(rr.parseJudgeOutput('', 2), null);
});

test('parseJudgeOutput: strips markdown fences', () => {
  const out = rr.parseJudgeOutput('```json\n{"rankings":[{"index":0,"score":80,"rationale":"x"}]}\n```', 1);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].index, 0);
});

test('parseJudgeOutput: extracts embedded JSON from prose', () => {
  const out = rr.parseJudgeOutput('My judgment is: {"rankings":[{"index":0,"score":90,"rationale":"good"}]}', 1);
  assert.strictEqual(out.length, 1);
});

test('parseJudgeOutput: filters out indices outside [0,n)', () => {
  const out = rr.parseJudgeOutput(
    JSON.stringify({
      rankings: [
        { index: 0, score: 90, rationale: 'ok' },
        { index: 5, score: 70, rationale: 'invalid' },
        { index: -1, score: 60, rationale: 'invalid' },
      ],
    }),
    2
  );
  assert.strictEqual(out.length, 1, 'only index 0 should remain (5 and -1 are out of [0,2))');
});

test('parseJudgeOutput: deduplicates duplicate indices', () => {
  const out = rr.parseJudgeOutput(
    JSON.stringify({
      rankings: [
        { index: 0, score: 90, rationale: 'first' },
        { index: 0, score: 70, rationale: 'duplicate' },
      ],
    }),
    1
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].score, 90, 'first occurrence kept');
});

test('parseJudgeOutput: clamps rationale to 200 chars', () => {
  const long = 'x'.repeat(500);
  const out = rr.parseJudgeOutput(JSON.stringify({ rankings: [{ index: 0, score: 90, rationale: long }] }), 1);
  assert.strictEqual(out[0].rationale.length, 200);
});

// ─── generateNDrafts ────────────────────────────────────────────────────────

test('generateNDrafts: returns all valid drafts in original order', async () => {
  const out = await rr.generateNDrafts({
    generateDraft: async (i) => `Draft ${i}`,
    n: 4,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(
    out.map((d) => d.originalIndex),
    [0, 1, 2, 3]
  );
});

test('generateNDrafts: skips drafts that throw, keeps the rest', async () => {
  metrics.reset();
  const out = await rr.generateNDrafts({
    generateDraft: async (i) => {
      if (i === 1 || i === 3) throw new Error('boom');
      return `Draft ${i}`;
    },
    n: 4,
    role: 'ad_copy',
    metrics,
  });
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(
    out.map((d) => d.originalIndex),
    [0, 2]
  );
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some((k) => k.startsWith('nbest_drafts_failed_total')));
});

test('generateNDrafts: skips drafts that return null/empty', async () => {
  const out = await rr.generateNDrafts({
    generateDraft: async (i) => (i === 2 ? null : i === 3 ? '   ' : `D${i}`),
    n: 4,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 2);
});

test('generateNDrafts: deduplicates identical drafts (case + whitespace insensitive)', async () => {
  const out = await rr.generateNDrafts({
    generateDraft: async (i) => (i < 2 ? 'Buy now!' : i < 4 ? '  buy now!  ' : 'Different'),
    n: 5,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 2, 'Buy now! variants should collapse');
});

// ─── nBestPick ──────────────────────────────────────────────────────────────

test('nBestPick: throws on missing callClaude', async () => {
  await assert.rejects(rr.nBestPick({ generateDraft: async () => 'x', n: 2 }), /callClaude required/);
});

test('nBestPick: throws on missing generateDraft', async () => {
  await assert.rejects(rr.nBestPick({ callClaude: async () => '', n: 2 }), /generateDraft required/);
});

test('nBestPick: throws on n<1 or topK<1', async () => {
  const cc = async () => '';
  const gd = async () => 'x';
  await assert.rejects(rr.nBestPick({ callClaude: cc, generateDraft: gd, n: 0 }), /n must be/);
  await assert.rejects(rr.nBestPick({ callClaude: cc, generateDraft: gd, n: 2, topK: 0 }), /topK must be/);
});

test('nBestPick: returns top-K based on judge rankings', async () => {
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      return JSON.stringify({
        rankings: [
          { index: 2, score: 95, rationale: 'best' },
          { index: 0, score: 80, rationale: 'good' },
          { index: 1, score: 65, rationale: 'meh' },
        ],
      });
    }
    return '';
  };
  const drafts = ['Boring ad', 'Generic ad', 'Specific 12,847-customer ad'];
  const out = await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => drafts[i],
    n: 3,
    topK: 2,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].draft, 'Specific 12,847-customer ad');
  assert.strictEqual(out[0].score, 95);
  assert.strictEqual(out[1].draft, 'Boring ad');
});

test('nBestPick: skips judge when only 1 valid draft (no point ranking 1 thing)', async () => {
  let judgeCalls = 0;
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      judgeCalls++;
      return '';
    }
    return '';
  };
  const out = await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => (i === 0 ? 'only one' : null),
    n: 3,
    topK: 2,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].draft, 'only one');
  assert.strictEqual(judgeCalls, 0);
});

test('nBestPick: returns empty when all drafts fail', async () => {
  const out = await rr.nBestPick({
    callClaude: async () => '',
    generateDraft: async () => {
      throw new Error('always fails');
    },
    n: 3,
    topK: 2,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 0);
});

test('nBestPick: judge failure falls back to insertion order (still ships top-K)', async () => {
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) throw new Error('Haiku is on fire');
    return '';
  };
  const out = await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => `Draft ${i}`,
    n: 5,
    topK: 2,
    role: 'ad_copy',
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].draft, 'Draft 0');
  assert.strictEqual(out[0].rationale, 'judge unavailable');
});

test('nBestPick: malformed judge JSON falls back to insertion order', async () => {
  metrics.reset();
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) return 'this is not json at all';
    return '';
  };
  const out = await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => `Draft ${i}`,
    n: 3,
    topK: 2,
    role: 'ad_copy',
    metrics,
  });
  assert.strictEqual(out.length, 2);
  const snap = metrics.snapshot();
  assert.ok(Object.keys(snap.counters).some((k) => k.startsWith('nbest_judge_malformed_total')));
});

test('nBestPick: passes judgeCriteria into the system prompt', async () => {
  let capturedSystem;
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      capturedSystem = args.system;
      return JSON.stringify({ rankings: [{ index: 0, score: 90, rationale: 'x' }] });
    }
    return '';
  };
  await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => `D${i}`,
    n: 2,
    topK: 1,
    role: 'ad_copy',
    judgeCriteria: 'Maximize specificity to Tirana customers',
  });
  assert.match(capturedSystem, /Tirana customers/);
});

test('nBestPick: angles param passes cycling angle to generateDraft', async () => {
  const seenAngles = [];
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      return JSON.stringify({
        rankings: [
          { index: 0, score: 90, rationale: 'a' },
          { index: 1, score: 80, rationale: 'b' },
        ],
      });
    }
    return '';
  };
  await rr.nBestPick({
    callClaude,
    generateDraft: async (i, angle) => {
      seenAngles.push({ i, angle });
      return `Draft ${i} (${angle})`;
    },
    n: 4,
    topK: 2,
    angles: ['mainstream', 'contrarian'],
    role: 'ad_copy',
  });
  // 4 calls × 2 angles cycled
  assert.deepStrictEqual(
    seenAngles.map((s) => s.angle),
    ['mainstream', 'contrarian', 'mainstream', 'contrarian']
  );
});

test('nBestPick: without angles, generateDraft receives null as second arg', async () => {
  let seenAngle = 'not-touched';
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      return JSON.stringify({ rankings: [{ index: 0, score: 90, rationale: 'x' }] });
    }
    return '';
  };
  await rr.nBestPick({
    callClaude,
    generateDraft: async (i, angle) => {
      seenAngle = angle;
      return `Draft ${i}`;
    },
    n: 2,
    topK: 1,
    role: 'ad_copy',
  });
  assert.strictEqual(seenAngle, null);
});

test('nBestPick: ANGLE_TAXONOMY exports the 8 standard psychological angles', () => {
  assert.strictEqual(rr.ANGLE_TAXONOMY.length, 8);
  for (const a of [
    'mainstream',
    'contrarian',
    'fomo',
    'social_proof',
    'authority',
    'curiosity',
    'reciprocity',
    'specificity',
  ]) {
    assert.ok(rr.ANGLE_TAXONOMY.includes(a), `${a} should be in taxonomy`);
  }
});

test('nBestPick: emits telemetry counters', async () => {
  metrics.reset();
  const callClaude = async (args) => {
    if (args.system?.includes('judge')) {
      return JSON.stringify({ rankings: [{ index: 0, score: 90, rationale: 'x' }] });
    }
    return '';
  };
  await rr.nBestPick({
    callClaude,
    generateDraft: async (i) => `D${i}`,
    n: 3,
    topK: 1,
    role: 'social_post',
    metrics,
  });
  const snap = metrics.snapshot();
  const keys = Object.keys(snap.counters);
  assert.ok(keys.some((k) => k.startsWith('nbest_runs_total') && k.includes('role="social_post"')));
  assert.ok(Object.keys(snap.histograms).some((k) => k.startsWith('nbest_duration_ms')));
});
