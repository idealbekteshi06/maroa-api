'use strict';

/**
 * services/cold-start/index.js
 * ---------------------------------------------------------------------------
 * Cold-start onboarding service.
 *
 * Customer signs up → /webhook/cold-start-trigger fires → creates a
 * cold_start_runs row → Inngest function picks up the maroa/cold-start.run
 * event → runs phases until awaiting_input or complete.
 *
 * If the customer takes the awaiting action (uploads photos, approves
 * concept), the corresponding endpoint sends maroa/cold-start.resume to
 * Inngest, which runs the next phases.
 *
 * Public API:
 *   ensureRun(businessId)       → cold_start_runs row (creates if missing)
 *   getRun(businessId)          → row or null
 *   advance(businessId, deps)   → run one phase, return new state
 *   resume(businessId, deps)    → run phases until stop
 *   approveConcept(args)        → mark a concept approved (auto-resumes)
 *   buildDeps()                 → standard deps container assembled at call site
 * ---------------------------------------------------------------------------
 */

const orchestrator = require('./orchestrator');
const phases = require('./phases');

async function ensureRun({ businessId, sbGet, sbPost }) {
  const existing = await sbGet('cold_start_runs', `business_id=eq.${businessId}&select=*&limit=1`).catch(() => []);
  if (existing && existing[0]) return existing[0];

  // Create new run with default first phase
  await sbPost('cold_start_runs', {
    business_id: businessId,
    current_phase: 'classify_industry',
    status: 'running',
    phase_results: {},
    display_state: { pct_complete: 0, current_phase: 'classify_industry', last_updated_at: new Date().toISOString() },
  }).catch(() => {});

  // Re-fetch (Supabase return=minimal so we don't get the row back from POST)
  const created = await sbGet('cold_start_runs', `business_id=eq.${businessId}&select=*&limit=1`).catch(() => []);
  return created?.[0] || null;
}

async function getRun({ businessId, sbGet }) {
  const rows = await sbGet('cold_start_runs', `business_id=eq.${businessId}&select=*&limit=1`).catch(() => []);
  return rows?.[0] || null;
}

async function advance({ businessId, deps }) {
  const run = await ensureRun({ businessId, sbGet: deps.sbGet, sbPost: deps.sbPost });
  if (!run) throw new Error('failed to create cold-start run');
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return { run, advanced: false, terminal: true };
  }
  return orchestrator.runOnePhase({ run, deps });
}

async function resume({ businessId, deps }) {
  const run = await ensureRun({ businessId, sbGet: deps.sbGet, sbPost: deps.sbPost });
  if (!run) throw new Error('failed to create cold-start run');
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return { run, advanced: false, terminal: true };
  }
  return orchestrator.runAllPhasesUntilStop({ run, deps });
}

async function approveConcept({ businessId, conceptId, userId, deps }) {
  const { sbGet, sbPatch } = deps;

  // Find the concept and validate it belongs to this business
  const conceptRows = await sbGet(
    'cold_start_concepts',
    `id=eq.${conceptId}&business_id=eq.${businessId}&select=id,run_id,status`
  ).catch(() => []);
  const concept = conceptRows?.[0];
  if (!concept) return { ok: false, reason: 'concept not found for this business' };
  if (concept.status === 'approved') return { ok: true, alreadyApproved: true };

  // Approve the chosen concept
  await sbPatch('cold_start_concepts', `id=eq.${conceptId}`, {
    status: 'approved',
    approved_at: new Date().toISOString(),
    approved_by: userId || null,
  }).catch(() => {});

  // Supersede the others in the same run
  await sbPatch('cold_start_concepts', `run_id=eq.${concept.run_id}&id=neq.${conceptId}&status=eq.proposed`, {
    status: 'superseded',
  }).catch(() => {});

  // Move the run forward off await_concept_approval
  return resume({ businessId, deps });
}

module.exports = {
  ensureRun,
  getRun,
  advance,
  resume,
  approveConcept,
  phases,
  orchestrator,
};
