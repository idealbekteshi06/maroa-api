'use strict';

/**
 * services/prompts/advisor-tool/index.js
 * ----------------------------------------------------------------------------
 * Advisor Tool wrapper — Anthropic public beta (header advisor-tool-2026-03-01).
 *
 * Pairs:
 *   executor — fast model (Sonnet 4.5 default) that does the heavy lifting
 *   advisor  — smart model (Opus 4.7 default) that intervenes when executor
 *              encounters a hard subproblem
 *
 * The advisor is only invoked when needed (executor confidence drop, ambiguity,
 * or explicit "ask advisor" request). Net cost is closer to executor's price
 * than always-using-advisor.
 *
 * Backwards-compatible: if MAROA_ADVISOR_ENABLED env is false (or callClaude
 * doesn't pass through `extra.useAdvisor`), this falls back to plain executor
 * call. Calling code can switch back to standard via a single env flag.
 * ----------------------------------------------------------------------------
 */

const ADVISOR_BETA = 'advisor-tool-2026-03-01';

const DEFAULT_EXECUTOR = 'claude-sonnet-4-5';
const DEFAULT_ADVISOR  = 'claude-opus-4-7';

/**
 * Decide whether to use the advisor for a given (task, budget) pair.
 * Pure-deterministic — no LLM needed.
 */
function shouldUseAdvisor({ task = 'audit', budget = 'standard', planTier = 'growth' } = {}) {
  if (process.env.MAROA_ADVISOR_ENABLED === 'false') return false;
  // Free tier: never use advisor (cost protection)
  if (String(planTier).toLowerCase() === 'free') return false;
  // Quick-only budget: no advisor (we want speed)
  if (String(budget).toLowerCase() === 'quick') return false;

  // Always-on tasks where Opus-level reasoning matters most:
  const advisorTasks = new Set([
    'audit',         // ad-optimizer / cro / ai-seo audits
    'strategy',      // creative-director, weekly-scorecard commentary
    'rewrite',       // hero/CTA rewrites
    'forecast',      // forecasting engine
    'voc-synthesis', // voice-of-customer extraction
  ]);
  return advisorTasks.has(task);
}

/**
 * Build the full advisor-aware request shape that callClaude can pass through.
 *
 * Shape (when callClaude supports it):
 *   {
 *     model: <executor>,
 *     extra: {
 *       extraBetas: ['advisor-tool-2026-03-01', ...other],
 *       advisor: { model: <advisor>, mode: 'auto' | 'always' | 'on_request' },
 *     },
 *   }
 *
 * If the runtime callClaude doesn't recognize the advisor field, the call
 * silently degrades to plain executor — no breakage.
 */
function buildAdvisorOptions({ executor, advisor, mode = 'auto', existingExtraBetas = [] } = {}) {
  const ex = executor || DEFAULT_EXECUTOR;
  const ad = advisor  || DEFAULT_ADVISOR;
  return {
    model: ex,
    extraBetas: [ADVISOR_BETA, ...existingExtraBetas],
    advisor: {
      model: ad,
      mode, // 'auto' = fire when executor hesitates, 'always' = check every reply
    },
  };
}

/**
 * Public wrapper. Drop-in replacement for callClaude in expert flows.
 * Falls back gracefully to executor-only if advisor isn't enabled or supported.
 *
 * Returns whatever callClaude returns (text or full response, depending on
 * extra.returnFullResponse). Adds .advisor_invoked = true|false to the response
 * if returnFullResponse=true.
 */
async function callWithAdvisor(opts = {}) {
  const {
    callClaude,
    system, user,
    executor, advisor, task, budget, planTier,
    extra = {},
    extraBetas = [],
    max_tokens,
    temperature,
  } = opts;

  if (typeof callClaude !== 'function') {
    throw new Error('callWithAdvisor: callClaude required');
  }

  const useAdvisor = shouldUseAdvisor({ task, budget, planTier });
  const opt = useAdvisor
    ? buildAdvisorOptions({ executor, advisor, existingExtraBetas: extraBetas })
    : { model: executor || DEFAULT_EXECUTOR, extraBetas };

  // Compose extra — keep caller's flags + add advisor metadata
  const composedExtra = {
    ...extra,
    extraBetas: opt.extraBetas,
    ...(useAdvisor ? { advisor: opt.advisor } : {}),
    ...(temperature != null ? { temperature } : {}),
  };

  return callClaude({
    system,
    user,
    model: opt.model,
    max_tokens,
    extra: composedExtra,
  });
}

/**
 * Decide on the right executor + advisor pair for a plan tier.
 * Convenience helper used by callers that want to abstract model selection.
 */
function modelsFor(planTier) {
  const t = String(planTier || 'free').toLowerCase();
  if (t === 'agency')  return { executor: 'claude-opus-4-7',   advisor: 'claude-opus-4-7'   };
  if (t === 'growth')  return { executor: 'claude-sonnet-4-5', advisor: 'claude-opus-4-7'   };
  return                       { executor: 'claude-sonnet-4-5', advisor: null               }; // free
}

module.exports = {
  ADVISOR_BETA,
  DEFAULT_EXECUTOR,
  DEFAULT_ADVISOR,
  shouldUseAdvisor,
  buildAdvisorOptions,
  callWithAdvisor,
  modelsFor,
};
