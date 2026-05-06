'use strict';

/**
 * services/prompts/memory-loop/index.js
 * ----------------------------------------------------------------------------
 * Cross-session learning helper. Wraps Maroa's existing anthropic-memory.js
 * service into a loop pattern: read prior facts → run task → append learnings.
 *
 *   Existing services/anthropic-memory.js gives us:
 *     ensureSession({ externalId }) → memory_session_id
 *     appendFact({ sessionId, fact, metadata })
 *     getSession(sessionId) → full thread (or null)
 *     deleteSession(sessionId)
 *
 *   This module adds:
 *     buildPriorContext(business, scope) → array of relevant prior facts
 *     extractLearnings(taskName, input, output, metrics) → array of facts to save
 *     applyMemoryLoop(opts) → orchestrates read+task+write in one call
 *
 * Scope keys we use:
 *   `wf1.<businessId>`            → daily content engine learnings
 *   `ad-optimizer.<businessId>`   → ad audit decision learnings
 *   `creative.<businessId>`       → creative concept performance learnings
 *
 * The agent gets BETTER over time per business because relevant prior facts
 * are automatically injected as additional system context.
 *
 * Backwards compatible: if memory service unavailable, runs as plain task
 * (no learning, no breakage).
 * ----------------------------------------------------------------------------
 */

const MAX_FACTS_PER_INJECTION = 25; // keep prompt size reasonable
const MAX_FACT_AGE_DAYS = 90;       // older facts get pruned out of context

// ─── Scope helpers ─────────────────────────────────────────────────────────

function buildScope(domain, businessId) {
  return `${domain}.${businessId}`;
}

// ─── Fact extraction patterns ──────────────────────────────────────────────

/**
 * For each task type, what counts as a "learning" worth saving?
 * Returns an array of fact strings, or [] if nothing notable happened.
 *
 * The patterns here are WHAT MAKES THIS EXPERT-LEVEL — a generic memory
 * service would save everything. We only save what compounds:
 *   - Decisions that worked (positive outcomes)
 *   - Decisions that didn't (negative outcomes)
 *   - Specific phrases/numbers that beat generic ones
 *   - Anti-patterns we should avoid next time
 */
function extractLearnings({ task, input, output, outcome }) {
  if (!output) return [];
  const facts = [];

  switch (task) {
    case 'wf1.content':
      // What captions worked? What didn't?
      if (outcome?.engagement_pct != null) {
        const isHighEngagement = outcome.engagement_pct > (input?.baseline_engagement_pct || 1.5);
        if (isHighEngagement && output.caption) {
          facts.push(`High-engagement pattern (${(outcome.engagement_pct * 100).toFixed(1)}%): "${truncate(output.caption, 200)}" — keep using this hook style.`);
        }
        if (!isHighEngagement && output.caption && outcome.engagement_pct < 0.5) {
          facts.push(`Low-engagement pattern (${(outcome.engagement_pct * 100).toFixed(2)}%): "${truncate(output.caption, 200)}" — avoid this hook style.`);
        }
      }
      break;

    case 'ad-optimizer.audit':
      // What decisions led to good/bad outcomes 7-14 days later?
      if (outcome?.decision_followup_roas_change != null) {
        const decision = output.decision || 'unknown';
        const change = outcome.decision_followup_roas_change;
        if (Math.abs(change) > 0.2) {
          facts.push(
            `${decision === 'scale' || decision === 'optimize' ? 'Budget' : decision} decision led to ${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}% ROAS change at ${input?.market_tier || 'unknown'} tier with ${input?.budget_tier || 'unknown'} budget — ${change > 0 ? 'good signal' : 'reconsider'}.`
          );
        }
      }
      break;

    case 'creative.concept':
      if (outcome?.engagement_pct != null && output.top_concept?.pattern) {
        const pattern = output.top_concept.pattern;
        const eng = outcome.engagement_pct;
        facts.push(`Creative pattern "${pattern}" produced ${(eng * 100).toFixed(1)}% engagement.`);
      }
      break;

    case 'voc.synthesis':
      // Save the top customer phrase — it'll inform future ad copy
      if (output.pain_points?.[0]?.verbatim_quotes?.[0]) {
        facts.push(`Top customer phrase: "${truncate(output.pain_points[0].verbatim_quotes[0], 150)}" — use in ad copy + landing page.`);
      }
      break;

    default:
      // Unknown task — don't save anything (avoid memory pollution)
      break;
  }

  return facts;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ─── Build prior context for prompt injection ──────────────────────────────

/**
 * Format prior facts for inclusion in a system prompt.
 * Returns a string ready to append to the system block, or '' if no facts.
 */
function buildPriorContextBlock(facts) {
  if (!Array.isArray(facts) || !facts.length) return '';
  const recent = facts.slice(0, MAX_FACTS_PER_INJECTION);
  return [
    '',
    '# PRIOR LEARNINGS FOR THIS BUSINESS (cross-session memory)',
    '',
    'These are facts learned from past runs. Apply them. They override generic best-practice when they conflict.',
    '',
    ...recent.map((f, i) => `${i + 1}. ${f}`),
    '',
  ].join('\n');
}

/**
 * Filter prior facts to only "fresh" ones (< MAX_FACT_AGE_DAYS).
 * Removes stale guidance that may no longer apply.
 */
function freshFactsOnly(facts) {
  if (!Array.isArray(facts)) return [];
  const now = Date.now();
  const cutoff = now - MAX_FACT_AGE_DAYS * 86400000;
  return facts
    .filter(f => {
      const ts = new Date(f.created_at || f.timestamp || 0).getTime();
      return !ts || ts >= cutoff;
    })
    .map(f => typeof f === 'string' ? f : (f.fact || f.text || ''))
    .filter(Boolean);
}

// ─── Apply the loop ────────────────────────────────────────────────────────

/**
 * Orchestrate read+task+write in one call.
 *
 * opts.memoryService → instance of services/anthropic-memory.js (optional)
 * opts.scope         → e.g. "wf1.<businessId>"
 * opts.task          → 'wf1.content' | 'ad-optimizer.audit' | etc.
 * opts.runTask       → async (priorContextBlock) → { input, output }
 * opts.outcome       → optional outcome data for learning extraction
 * opts.logger        → optional
 *
 * Returns { input, output, factsRead, factsWritten, sessionId }.
 */
async function applyMemoryLoop(opts) {
  const {
    memoryService,
    scope,
    task,
    runTask,
    outcome,
    logger,
  } = opts || {};

  if (typeof runTask !== 'function') throw new Error('applyMemoryLoop: runTask required');

  let priorContextBlock = '';
  let priorFacts = [];
  let sessionId = null;

  // ─── Read prior facts ─────────────────────────────────────────────────
  if (memoryService && scope) {
    try {
      const session = await memoryService.ensureSession({ externalId: scope });
      sessionId = session?.id || session?.session_id || null;
      if (sessionId) {
        const full = await memoryService.getSession(sessionId).catch(() => null);
        const rawFacts = full?.facts || full?.memory || [];
        priorFacts = freshFactsOnly(rawFacts);
        priorContextBlock = buildPriorContextBlock(priorFacts);
      }
    } catch (e) {
      logger?.warn?.('memory-loop', null, 'read prior facts failed (continuing without)', e?.message);
    }
  }

  // ─── Run the task ─────────────────────────────────────────────────────
  const result = await runTask(priorContextBlock);

  // ─── Extract + save new facts ─────────────────────────────────────────
  let factsWritten = 0;
  if (memoryService && sessionId) {
    const newFacts = extractLearnings({
      task,
      input: result?.input,
      output: result?.output,
      outcome,
    });
    for (const fact of newFacts) {
      try {
        await memoryService.appendFact({ sessionId, fact, metadata: { task, scope } });
        factsWritten++;
      } catch (e) {
        logger?.warn?.('memory-loop', null, 'appendFact failed', e?.message);
      }
    }
  }

  return {
    ...result,
    factsRead: priorFacts.length,
    factsWritten,
    sessionId,
  };
}

module.exports = {
  buildScope,
  extractLearnings,
  buildPriorContextBlock,
  freshFactsOnly,
  applyMemoryLoop,
  MAX_FACTS_PER_INJECTION,
  MAX_FACT_AGE_DAYS,
};
