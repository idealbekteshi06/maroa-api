'use strict';

/**
 * lib/nBestReranker.js
 * ---------------------------------------------------------------------------
 * N-best generation + LLM-as-judge reranker. Pillar #2 of the closed-loop
 * creative system. The playbook calls this "MCTS" — it isn't, technically
 * (no tree search). But the value is real: brainstorm in parallel at the
 * scale humans physically can't, then use Haiku-as-judge to pick winners.
 *
 * The cost model that makes this viable:
 *   N drafts × Sonnet  (~$0.003 each at 800 tokens)  = $0.024 for N=8
 *   1 judge call × Haiku (~$0.001 to score all 8)    = $0.001
 *   2 winners ship
 *   Total per "best-of-8 selection": ~$0.025 per surface per business
 *
 * The same cost as 1 single-shot generation today but with the chance to
 * pick from 8 angles instead of 1. Real lift on conversion comes from
 * picking the right angle — not from making one angle better.
 *
 * API:
 *
 *   const winners = await nBestPick({
 *     callClaude,
 *     generateDraft: async (i) => string,   // your draft producer, called N times in parallel
 *     n: 8,
 *     topK: 2,
 *     judgeModel: 'claude-haiku-4-5',
 *     judgeCriteria: 'string describing what good looks like for this surface',
 *     role: 'ad_copy',
 *     businessId,
 *     skill,
 *     metrics, logger,
 *   })
 *   // → [{ draft, score, rationale }, { draft, score, rationale }]
 *
 * Failure modes (all soft-fail to ensure something ships):
 *   - generateDraft throws on some i  → those drafts skipped, judge sees the rest
 *   - judge throws                    → return top-K by insertion order
 *   - judge JSON malformed            → same as judge throws
 *   - generateDraft returns dupes     → de-duped before judging (saves cost)
 *
 * Telemetry:
 *   - nbest_runs_total{role,n,topK}
 *   - nbest_drafts_failed_total{role}
 *   - nbest_judge_malformed_total{role}
 *   - nbest_duration_ms{role}
 * ---------------------------------------------------------------------------
 */

const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5';

function buildJudgeSystemPrompt(role, criteria) {
  return `You are a marketing judge ranking ${role.replace(/_/g, ' ')} drafts.

You will receive N drafts. Score each one 0-100 based on:
${criteria || '- Specificity (real numbers, real customers, real claims)\n- Hook strength (does the first 5 words earn the rest?)\n- Avoiding clichés / corporate / AI-coded phrasing\n- Match to the brief'}

Output ONLY this JSON, no prose, no markdown:

{
  "rankings": [
    { "index": <0-based draft index>, "score": <0-100>, "rationale": "one sentence why" }
  ]
}

Rankings array MUST include every draft index exactly once, sorted by score descending.
If two drafts are equally good, break ties by which one is MORE specific.
Do not be precious. Most differences are real. Do not assign identical scores unless drafts are truly indistinguishable.`;
}

/**
 * Parse the judge's JSON output. Defensive — returns null on any parse
 * failure so caller falls back to insertion order.
 */
function parseJudgeOutput(rawText, expectedN) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || !Array.isArray(parsed.rankings)) return null;
  const rankings = parsed.rankings
    .filter((r) => r && typeof r === 'object' && Number.isInteger(r.index))
    .map((r) => ({
      index: r.index,
      score: typeof r.score === 'number' ? r.score : 0,
      rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 200) : '',
    }))
    .filter((r) => r.index >= 0 && r.index < expectedN);
  if (!rankings.length) return null;
  // Dedup duplicate indices — keep first occurrence
  const seen = new Set();
  return rankings.filter((r) => {
    if (seen.has(r.index)) return false;
    seen.add(r.index);
    return true;
  });
}

/**
 * Standard psychological-angle taxonomy. Each angle pushes the generator
 * toward a distinct persuasive stance — agencies brainstorm 3 of these;
 * we run all 8 in parallel and let the judge pick.
 *
 * Pass `angles: ANGLE_TAXONOMY` (or a subset) to `nBestPick` to wire it
 * in. generateDraft now receives `(i, angle)` instead of just `(i)` —
 * callers append the angle to their system prompt as a one-line tag.
 */
const ANGLE_TAXONOMY = Object.freeze([
  'mainstream', // safe, expected, broad-appeal
  'contrarian', // identify status quo, take opposite stance
  'fomo', // loss aversion / scarcity
  'social_proof', // many-others-are-doing-it
  'authority', // expert / data / credentials
  'curiosity', // open loop, withheld payoff
  'reciprocity', // give value first, ask later
  'specificity', // exact numbers, exact names, exact moments
]);

/**
 * Generate N drafts in parallel. Soft-fails any that throw — they are
 * just skipped. Returns the kept drafts in original index order.
 *
 * When `angles` is supplied, `generateDraft(i, angle)` is called with
 * angle = angles[i % angles.length]. This drives intentional creative
 * diversity at the angle level rather than relying on temperature noise.
 */
async function generateNDrafts({ generateDraft, n, role, metrics, angles }) {
  const useAngles = Array.isArray(angles) && angles.length > 0;
  const tasks = Array.from({ length: n }, (_, i) => {
    const angle = useAngles ? angles[i % angles.length] : null;
    return Promise.resolve()
      .then(() => generateDraft(i, angle))
      .catch(() => null);
  });
  const results = await Promise.all(tasks);
  let failed = 0;
  const drafts = [];
  results.forEach((r, i) => {
    if (typeof r === 'string' && r.trim()) {
      drafts.push({ originalIndex: i, draft: r.trim() });
    } else {
      failed++;
    }
  });
  if (failed > 0 && metrics?.increment) {
    metrics.increment('nbest_drafts_failed_total', { role }, failed);
  }
  // Dedup identical drafts to save judge tokens
  const seen = new Set();
  return drafts.filter((d) => {
    const key = d.draft.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Run the judge on a batch of drafts. Returns null on any failure so
 * caller falls back to "insertion order" (which is at least N).
 */
async function rankDrafts({
  callClaude,
  drafts, // [{originalIndex, draft}]
  role,
  judgeCriteria,
  judgeModel = DEFAULT_JUDGE_MODEL,
  businessId,
  skill,
  metrics,
}) {
  if (drafts.length < 2) return null; // nothing to rerank
  const system = buildJudgeSystemPrompt(role, judgeCriteria);
  const numbered = drafts.map((d, i) => `[${i}] ${d.draft}`).join('\n\n---\n\n');
  const user = `Rank these ${drafts.length} drafts:\n\n${numbered}`;
  let raw;
  try {
    raw = await callClaude({
      system,
      user,
      model: judgeModel,
      max_tokens: 600,
      extra: {
        businessId,
        skill: skill || `nbest_judge_${role}`,
        skipBrandVoice: true, // judge must not be voice-anchored
        returnRaw: true,
      },
    });
  } catch {
    return null;
  }
  const text = typeof raw === 'string' ? raw : raw?._raw || raw?.text || '';
  const parsed = parseJudgeOutput(text, drafts.length);
  if (!parsed) {
    if (metrics?.increment) metrics.increment('nbest_judge_malformed_total', { role });
    return null;
  }
  return parsed;
}

/**
 * Main entrypoint. Generates N drafts, has the judge rank them, returns
 * top-K. Always returns at least min(topK, validDrafts) items unless
 * everything failed.
 */
async function nBestPick({
  callClaude,
  generateDraft,
  n = 8,
  topK = 2,
  judgeModel = DEFAULT_JUDGE_MODEL,
  judgeCriteria,
  role = 'generic',
  businessId,
  skill,
  metrics,
  logger,
  // Optional: array of psychological angles to assign to each draft.
  // When set, generateDraft(i, angle) is called with cycled angles —
  // forces creative diversity instead of relying on temperature noise.
  // See ANGLE_TAXONOMY for the curated default set.
  angles,
} = {}) {
  if (!callClaude) throw new Error('nBestReranker.nBestPick: callClaude required');
  if (typeof generateDraft !== 'function') {
    throw new Error('nBestReranker.nBestPick: generateDraft required');
  }
  if (n < 1) throw new Error('nBestReranker.nBestPick: n must be ≥1');
  if (topK < 1) throw new Error('nBestReranker.nBestPick: topK must be ≥1');

  const start = Date.now();
  if (metrics?.increment) metrics.increment('nbest_runs_total', { role, n, topK });

  // Step 1: generate in parallel (with angles if supplied for diversity)
  const drafts = await generateNDrafts({ generateDraft, n, role, metrics, angles });

  let winners;
  if (drafts.length === 0) {
    winners = [];
  } else if (drafts.length === 1) {
    winners = [{ draft: drafts[0].draft, score: null, rationale: 'only valid draft' }];
  } else {
    // Step 2: judge
    const rankings = await rankDrafts({
      callClaude,
      drafts,
      role,
      judgeCriteria,
      judgeModel,
      businessId,
      skill,
      metrics,
    });
    if (!rankings) {
      // Judge failed — fall back to insertion order
      winners = drafts.slice(0, topK).map((d) => ({ draft: d.draft, score: null, rationale: 'judge unavailable' }));
    } else {
      winners = rankings.slice(0, topK).map((r) => {
        const d = drafts[r.index];
        return { draft: d ? d.draft : null, score: r.score, rationale: r.rationale };
      });
      winners = winners.filter((w) => w.draft);
    }
  }

  const duration = Date.now() - start;
  if (metrics?.observeHistogram) metrics.observeHistogram('nbest_duration_ms', duration, { role });
  if (logger?.info) {
    logger.info({
      event: 'nbest_pick',
      role,
      n,
      topK,
      drafts_generated: drafts.length,
      winners_count: winners.length,
      duration_ms: duration,
    });
  }
  return winners;
}

module.exports = {
  nBestPick,
  rankDrafts,
  generateNDrafts,
  parseJudgeOutput,
  buildJudgeSystemPrompt,
  DEFAULT_JUDGE_MODEL,
  ANGLE_TAXONOMY,
};
