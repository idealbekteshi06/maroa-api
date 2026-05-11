'use strict';

/**
 * services/cold-start/orchestrator.js
 * ---------------------------------------------------------------------------
 * Drives a cold_start_runs row through its phases. Pure-ish: takes a deps
 * container, returns the new state. The Inngest function and the manual
 * /webhook/cold-start-resume endpoint both call this.
 *
 * Phases run in sequence. Each phase returns:
 *   { ok: true,  data: ... }                    — phase done, advance
 *   { ok: true,  awaitingInput: true, data: ... } — wait for customer
 *   { ok: false, reason: ... }                  — fail; orchestrator marks run failed
 *
 * The function STOPS on awaitingInput — Inngest waitForEvent (or the manual
 * resume endpoint) wakes it back up when the customer takes the action.
 * ---------------------------------------------------------------------------
 */

const phases = require('./phases');

const PHASE_FN = {
  classify_industry: phases.classifyIndustry,
  detect_competitors: phases.detectCompetitors,
  build_brand_voice_anchor: phases.buildBrandVoiceAnchor,
  train_soul_id: phases.trainSoulId,
  generate_concepts: phases.generateConcepts,
  await_concept_approval: phases.awaitConceptApproval,
  launch_initial_campaigns: phases.launchInitialCampaigns,
  schedule_first_content: phases.scheduleFirstContent,
  ship_ai_seo_baseline: phases.shipAiSeoBaseline,
};

function nextPhase(current) {
  const idx = phases.PHASES.indexOf(current);
  if (idx < 0 || idx >= phases.PHASES.length - 1) return null;
  return phases.PHASES[idx + 1];
}

function buildDisplayState(run, phaseResultData) {
  const pct = phases.PHASE_PCT[run.current_phase] ?? 0;
  return {
    pct_complete: pct,
    current_phase: run.current_phase,
    next_user_action: phaseResultData?.next_user_action || null,
    message: phaseResultData?.message || null,
    last_updated_at: new Date().toISOString(),
  };
}

/**
 * runOnePhase — advances the run by exactly one phase.
 * Caller is responsible for calling this in a loop until awaitingInput or completed.
 *
 * @returns { run, phaseResult, advanced }
 *   advanced === true means we moved to a new phase (or completed)
 *   advanced === false means we're awaiting input or hit a failure
 */
async function runOnePhase({ run, deps }) {
  const { sbPatch, logger, sentry } = deps;
  const phaseName = run.current_phase;
  const fn = PHASE_FN[phaseName];

  if (!fn) {
    // 'complete' or unknown — terminal state.
    if (phaseName === 'complete') {
      return { run, phaseResult: { ok: true, data: {} }, advanced: false };
    }
    const failed = await persistFailure({ run, deps, reason: `unknown phase: ${phaseName}` });
    return { run: failed, phaseResult: { ok: false, reason: 'unknown phase' }, advanced: false };
  }

  // Pull the previous phase's data (for chaining inputs)
  const prevPhase = phases.PHASES[Math.max(0, phases.PHASES.indexOf(phaseName) - 1)];
  const prevPhaseData = run.phase_results?.[prevPhase] || null;

  let phaseResult;
  try {
    phaseResult = await fn({ businessId: run.business_id, run, deps, prevPhaseData });
  } catch (e) {
    logger?.error?.('cold-start.orchestrator', run.business_id, `phase ${phaseName} threw`, e);
    sentry?.captureException?.(e, { tags: { module: 'cold-start', phase: phaseName, business_id: run.business_id } });
    phaseResult = { ok: false, reason: `phase ${phaseName} threw: ${e.message}` };
  }

  // Persist phase result
  const newPhaseResults = { ...(run.phase_results || {}), [phaseName]: phaseResult.data || {} };

  if (!phaseResult.ok) {
    const failed = await persistFailure({ run, deps, reason: phaseResult.reason || 'phase failed' });
    return { run: failed, phaseResult, advanced: false };
  }

  if (phaseResult.awaitingInput) {
    // Don't advance; persist awaiting state.
    const updates = {
      status: 'awaiting_input',
      phase_results: newPhaseResults,
      display_state: buildDisplayState({ ...run, current_phase: phaseName }, phaseResult.data),
    };
    await sbPatch?.('cold_start_runs', `id=eq.${run.id}`, updates).catch(() => {});
    await mirrorOnboardingState(run.business_id, updates.display_state, deps);
    return { run: { ...run, ...updates }, phaseResult, advanced: false };
  }

  // Advance to next phase
  const next = nextPhase(phaseName);
  const isComplete = next === null || next === 'complete';
  const updates = {
    current_phase: isComplete ? 'complete' : next,
    status: isComplete ? 'completed' : 'running',
    completed_at: isComplete ? new Date().toISOString() : null,
    phase_results: newPhaseResults,
    display_state: buildDisplayState({ ...run, current_phase: isComplete ? 'complete' : next }, phaseResult.data),
  };
  await sbPatch?.('cold_start_runs', `id=eq.${run.id}`, updates).catch(() => {});
  await mirrorOnboardingState(run.business_id, updates.display_state, deps);
  return { run: { ...run, ...updates }, phaseResult, advanced: true };
}

async function persistFailure({ run, deps, reason }) {
  const { sbPatch } = deps;
  const updates = {
    status: 'failed',
    failed_at: new Date().toISOString(),
    last_error: String(reason).slice(0, 500),
    retry_count: (run.retry_count || 0) + 1,
  };
  await sbPatch?.('cold_start_runs', `id=eq.${run.id}`, updates).catch(() => {});
  return { ...run, ...updates };
}

async function mirrorOnboardingState(businessId, displayState, deps) {
  await deps
    .sbPatch?.('businesses', `id=eq.${businessId}`, {
      onboarding_state: displayState,
    })
    .catch(() => {});
}

/**
 * runAllPhasesUntilStop — loops until awaiting_input, completed, or failed.
 * The Inngest function uses step.run() per phase for durability — but we keep
 * this synchronous loop available for the manual resume endpoint and for
 * testing.
 */
async function runAllPhasesUntilStop({ run, deps, maxPhases = 20 }) {
  let cur = run;
  let last;
  for (let i = 0; i < maxPhases; i += 1) {
    const result = await runOnePhase({ run: cur, deps });
    last = result;
    cur = result.run;
    if (!result.advanced) break;
    if (cur.status === 'completed' || cur.status === 'failed') break;
  }
  return last;
}

module.exports = {
  runOnePhase,
  runAllPhasesUntilStop,
  nextPhase,
  buildDisplayState,
  PHASE_FN,
};
