'use strict';

/**
 * services/agency-pipeline/index.js
 * ---------------------------------------------------------------------------
 * Wave 60 Session 10 — the master orchestrator that runs every customer-
 * facing generation through the full agency-grade pipeline:
 *
 *   1. ROUTE        stageRouter.detectAndRoute → awareness × funnel cell
 *   2. DISPATCH     specialists.pickSpecialist for the job
 *   3. COMPOSE      build prompt from:
 *                     - specialist persona
 *                     - methodology guidance (Wave 60 S1)
 *                     - channel-native segments (Wave 60 S3)
 *                     - compliance guidance (Wave 60 S5)
 *                     - cell config (CTA style, tone, manip risk ceiling)
 *   4. GENERATE     callClaude (dependency injected for tests)
 *   5. VALIDATE     in order:
 *                     a. compliance gate (HARD refusal on violations)
 *                     b. channel format check (warn-or-fix)
 *                     c. methodology score (informational)
 *                     d. ethics ceiling (manip_risk_total ≤ specialist
 *                        ceiling AND ≤ global 6)
 *   6. PERSIST      one row in agency_pipeline_runs for audit trail
 *   7. RETURN       { ok, generation, reasoning_trace, refused, ... }
 *
 * The pipeline is fully fail-safe: any internal step that throws is
 * caught and reported in the trace rather than propagated as a crash.
 * ---------------------------------------------------------------------------
 */

const stageRouter = require('../../lib/stageRouter');
const methodologies = require('../prompts/methodologies');
const channels = require('../prompts/channels');
const compliance = require('../prompts/compliance');
const specialists = require('../prompts/specialists');

const GLOBAL_MANIPULATION_RISK_CEILING = 6;

/**
 * @param {object} job  Input job spec
 * @param {string} job.businessId            UUID
 * @param {string} job.goal                  Free-text goal description
 * @param {string} [job.channel]             Channel ID (e.g. 'email-promo')
 * @param {string} [job.industry]            Industry ID (e.g. 'mortgage_broker')
 * @param {object} [job.customer_history]    For stage detection
 * @param {string} [job.current_content]     For Schwartz signal scoring
 * @param {string} [job.customer_type]       'new' | 'existing'
 * @param {object} [job.brandVoice]          Voice constraints (passed through)
 * @param {object} deps                      Dependency injection
 * @param {function} [deps.callClaude]       For generation step
 * @param {function} [deps.persistRun]       For audit-trail write (default: noop)
 * @returns {Promise<object>} {
 *   ok, refused, refusal_reason,
 *   detection, route, specialist,
 *   prompt_segments,
 *   generation,
 *   compliance, channel_validation, methodology_score, ethics,
 *   reasoning_trace, duration_ms,
 * }
 */
async function runAgencyPipeline(job = {}, deps = {}) {
  const start = Date.now();
  const trace = [];
  const log = (msg) => trace.push(`[${Date.now() - start}ms] ${msg}`);

  const { businessId, goal, channel, industry, customer_history, current_content, customer_type } = job;
  const {
    callClaude,
    persistRun = async () => {},
    // 2026-05-14: mirror agency_pipeline_runs into universal decision_logs so
    // the War Room UI (Phase 3) and per-workspace feed read from one source.
    // Optional — falls back silently if not wired.
    decisionLog,
  } = deps;

  if (!goal) {
    return _earlyExit({
      ok: false,
      refused: true,
      refusal_reason: 'no goal supplied',
      duration_ms: Date.now() - start,
      reasoning_trace: ['no goal supplied — pipeline aborted'],
    });
  }

  // ── 1. ROUTE ─────────────────────────────────────────────────────────
  let route;
  let detection;
  try {
    const r = await stageRouter.detectAndRoute({
      customer_history,
      current_content,
      channel,
      industry,
      callClaude,
    });
    route = r;
    detection = r.detection || {};
    log(
      `routed to ${detection.awareness}×${detection.funnel} (source=${detection.source}, conf=${detection.confidence})`
    );
  } catch (e) {
    log(`route step crashed: ${e.message} — using safe defaults`);
    route = { ok: false, refusal: `route failure: ${e.message}` };
    detection = { awareness: 'problem_aware', funnel: 'tofu', confidence: 0.0, source: 'fallback' };
  }

  if (!route.ok) {
    return _earlyExit({
      ok: false,
      refused: true,
      refusal_reason: route.refusal || 'route refused',
      detection,
      duration_ms: Date.now() - start,
      reasoning_trace: trace,
    });
  }

  // ── 2. DISPATCH SPECIALIST ───────────────────────────────────────────
  let specialistPick;
  try {
    specialistPick = specialists.pickSpecialist({
      goal,
      channel: route.channel,
      funnel_stage: detection.funnel,
      customer_type,
    });
    log(`specialist picked: ${specialistPick.specialist.id} (score=${specialistPick.score})`);
  } catch (e) {
    log(`specialist pick crashed: ${e.message} — defaulting to content-marketer`);
    specialistPick = {
      specialist: specialists.getSpecialist('content-marketer'),
      score: 0,
      runners_up: [],
    };
  }

  const specialist = specialistPick.specialist;

  // ── 3. COMPOSE PROMPT ────────────────────────────────────────────────
  const promptSegments = [];

  // Specialist brief
  for (const seg of specialist.generateBriefSegments({ industry, channel: route.channel })) {
    promptSegments.push(seg);
  }

  // Cell config
  promptSegments.push(
    `CELL: ${detection.awareness}×${detection.funnel} · CTA style=${route.cta_style} · tone=${route.tone}.`
  );
  if (route.max_length_hint) promptSegments.push(`TARGET LENGTH: ${route.max_length_hint}.`);

  // Methodology guidance — start with specialist's preferred list intersected
  // with the cell's recommendations, then drop highest-risk modules until
  // total manipulation_risk is within the specialist's ceiling. This means
  // a brand-builder (ceiling=2) ends up using fewer + lower-risk methodologies
  // than a direct-response specialist (ceiling=5), even when both could
  // technically run the same cell.
  const specialistCeilingForPick = specialist.manipulation_risk_ceiling || GLOBAL_MANIPULATION_RISK_CEILING;
  const candidatePool = (specialist.preferred_methodologies || []).filter(
    (id) => (route.methodologies || []).includes(id) || (specialist.preferred_methodologies || []).indexOf(id) < 4
  );
  const withRisk = candidatePool
    .map((id) => {
      const mod = methodologies.getFramework(id);
      return { id, risk: mod && mod !== methodologies.NULL_MODULE ? mod.manipulation_risk || 0 : 0 };
    })
    .sort((a, b) => a.risk - b.risk);

  const methodologyIds = [];
  let pickedRiskSum = 0;
  for (const { id, risk } of withRisk) {
    if (pickedRiskSum + risk <= specialistCeilingForPick) {
      methodologyIds.push(id);
      pickedRiskSum += risk;
      if (methodologyIds.length >= 4) break;
    }
  }
  log(
    `methodology pick: ${methodologyIds.join(', ')} (sum_risk=${pickedRiskSum}, ceiling=${specialistCeilingForPick})`
  );

  for (const mid of methodologyIds) {
    try {
      const mod = methodologies.getFramework(mid);
      if (mod && mod !== methodologies.NULL_MODULE) {
        const gen = mod.generateFromSpec({
          channel: route.channel,
          awareness_stage: detection.awareness,
          funnel_stage: detection.funnel,
          industry,
          goal,
        });
        for (const seg of gen.prompt_segments || []) promptSegments.push(`[${mid}] ${seg}`);
      }
    } catch (e) {
      log(`methodology ${mid} compose failed: ${e.message}`);
    }
  }

  // Channel-native segments
  if (route.channel_guidance && Array.isArray(route.channel_guidance.prompt_segments)) {
    for (const seg of route.channel_guidance.prompt_segments) promptSegments.push(`[channel] ${seg}`);
  }

  // Compliance guidance (industry-specific)
  let complianceGuidance = { rulesets_applied: [], prompt_segments: [] };
  if (industry) {
    try {
      complianceGuidance = compliance.getComplianceGuidance({ industry });
      for (const seg of complianceGuidance.prompt_segments) promptSegments.push(`[compliance] ${seg}`);
    } catch (e) {
      log(`compliance guidance crashed: ${e.message} — continuing without`);
    }
  }

  log(`composed prompt with ${promptSegments.length} segments`);

  // ── 4. GENERATE ──────────────────────────────────────────────────────
  let generation = '';
  if (callClaude) {
    try {
      const systemPrompt = promptSegments.join('\n\n');
      const userPrompt = `Goal: ${goal}\n\nWrite the requested copy following the rules above.`;
      const raw = await callClaude({
        system: systemPrompt,
        user: userPrompt,
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        extra: { businessId, skill: 'agency_pipeline' },
      });
      generation =
        typeof raw === 'string'
          ? raw
          : raw && (raw.text || raw._raw || (Array.isArray(raw.content) && raw.content[0]?.text) || '');
      log(`generated ${generation.length} chars`);
    } catch (e) {
      log(`generation crashed: ${e.message}`);
      return _earlyExit({
        ok: false,
        refused: true,
        refusal_reason: `generation failure: ${e.message}`,
        detection,
        route,
        specialist: { id: specialist.id, name: specialist.name },
        prompt_segments: promptSegments,
        duration_ms: Date.now() - start,
        reasoning_trace: trace,
      });
    }
  } else {
    log('no callClaude provided — pipeline returning prompt only (dry run)');
  }

  // ── 5. VALIDATE ──────────────────────────────────────────────────────

  // 5a. Compliance gate (HARD refusal)
  let complianceResult = { ok: true, violations: [], required_disclosures: [], rulesets_applied: [] };
  if (industry && generation) {
    try {
      complianceResult = compliance.applyCompliance({ draft: generation, industry });
      log(
        `compliance: ${complianceResult.ok ? 'OK' : 'BLOCKED'} (${complianceResult.violations.length} violations, ` +
          `${complianceResult.rulesets_applied.length} rulesets)`
      );
    } catch (e) {
      log(`compliance check crashed: ${e.message} — fail-closed`);
      complianceResult = { ok: false, violations: [{ severity: 'block', issue: `compliance error: ${e.message}` }] };
    }
  }

  // 5b. Channel format validation (soft)
  let channelValidation = { id: route.channel, score: 0, fixes: [] };
  if (route.channel && generation) {
    try {
      channelValidation = channels.applyChannel({ channelId: route.channel, draft: generation, context: { industry } });
      log(`channel ${route.channel}: score=${channelValidation.score}, fixes=${channelValidation.fixes.length}`);
    } catch (e) {
      log(`channel validation crashed: ${e.message}`);
    }
  }

  // 5c. Methodology scoring (informational)
  let methodologyScore = { per_framework: [], aggregate_score: 0, all_fixes: [], manipulation_risk_total: 0 };
  if (methodologyIds.length && generation) {
    try {
      methodologyScore = methodologies.applyFrameworks({
        draft: generation,
        frameworks: methodologyIds,
        context: {
          channel: route.channel,
          awareness_stage: detection.awareness,
          funnel_stage: detection.funnel,
          industry,
        },
      });
      log(
        `methodology aggregate=${methodologyScore.aggregate_score.toFixed(2)} ` +
          `manip_risk_total=${methodologyScore.manipulation_risk_total}`
      );
    } catch (e) {
      log(`methodology scoring crashed: ${e.message}`);
    }
  }

  // 5d. Ethics ceiling
  const manipulationRiskTotal = methodologyScore.manipulation_risk_total || 0;
  const specialistCeiling = specialist.manipulation_risk_ceiling || GLOBAL_MANIPULATION_RISK_CEILING;
  const effectiveCeiling = Math.min(specialistCeiling, GLOBAL_MANIPULATION_RISK_CEILING);
  const ethicsOk = manipulationRiskTotal <= effectiveCeiling;
  if (!ethicsOk) {
    log(
      `ETHICS REFUSAL: manip_risk_total=${manipulationRiskTotal} > ceiling=${effectiveCeiling} ` +
        `(specialist=${specialistCeiling}, global=${GLOBAL_MANIPULATION_RISK_CEILING})`
    );
  }

  // ── 6. TERMINAL STATE ────────────────────────────────────────────────
  const refused = !complianceResult.ok || !ethicsOk;
  const refusalReason = !complianceResult.ok
    ? `compliance: ${(complianceResult.violations[0] || {}).issue || 'unspecified'}`
    : !ethicsOk
      ? `ethics ceiling exceeded: ${manipulationRiskTotal} > ${effectiveCeiling}`
      : null;

  const result = {
    ok: !refused,
    refused,
    refusal_reason: refusalReason,
    detection,
    route: {
      awareness: route.awareness,
      funnel: route.funnel,
      channel: route.channel,
      industry: route.industry,
      cta_style: route.cta_style,
      tone: route.tone,
      max_length_hint: route.max_length_hint,
      methodologies: route.methodologies,
      max_manip_risk: route.max_manip_risk,
    },
    specialist: {
      id: specialist.id,
      name: specialist.name,
      score: specialistPick.score,
      runners_up: specialistPick.runners_up,
      manipulation_risk_ceiling: specialistCeiling,
    },
    prompt_segments: promptSegments,
    generation,
    compliance: {
      ok: complianceResult.ok,
      rulesets_applied: complianceResult.rulesets_applied,
      violations: complianceResult.violations,
      required_disclosures: complianceResult.required_disclosures,
    },
    channel_validation: channelValidation,
    methodology_score: {
      aggregate_score: methodologyScore.aggregate_score,
      all_fixes: methodologyScore.all_fixes,
      manipulation_risk_total: manipulationRiskTotal,
    },
    ethics: {
      ok: ethicsOk,
      manipulation_risk_total: manipulationRiskTotal,
      specialist_ceiling: specialistCeiling,
      global_ceiling: GLOBAL_MANIPULATION_RISK_CEILING,
    },
    reasoning_trace: trace,
    duration_ms: Date.now() - start,
  };

  // ── 7. PERSIST ───────────────────────────────────────────────────────
  try {
    await persistRun({
      business_id: businessId,
      job_goal: goal,
      channel: route.channel,
      industry,
      detected_awareness: detection.awareness,
      detected_funnel: detection.funnel,
      detection_source: detection.source,
      detection_confidence: detection.confidence,
      specialist_picked: specialist.id,
      specialist_score: specialistPick.score,
      specialist_runners_up: specialistPick.runners_up,
      methodologies_applied: methodologyIds,
      channel_guidance: route.channel_guidance,
      compliance_rulesets: complianceResult.rulesets_applied,
      generation_text: generation,
      critic_score: methodologyScore.aggregate_score,
      critic_fixes: methodologyScore.all_fixes,
      compliance_violations: complianceResult.violations,
      manipulation_risk_total: manipulationRiskTotal,
      manipulation_risk_ceiling: effectiveCeiling,
      ok: result.ok,
      refused,
      refusal_reason: refusalReason,
      duration_ms: result.duration_ms,
    });
  } catch (e) {
    log(`persist failed (non-fatal): ${e.message}`);
  }

  // ── 7a. MIRROR INTO decision_logs (universal audit) ──────────────────
  // The War Room UI reads from decision_logs. Mirror the agency-pipeline
  // outcome so it shows up alongside ad-optimizer, content-generate, etc.
  // Soft-fail: any error here is non-fatal — agency_pipeline_runs is the
  // canonical record.
  if (decisionLog && typeof decisionLog.proposeDecision === 'function') {
    try {
      const decision = await decisionLog.proposeDecision({
        businessId,
        agentName: 'agency-pipeline',
        decisionType: 'generate_content',
        decisionSubtype: route.channel || 'unknown_channel',
        inputs: {
          goal,
          channel: route.channel,
          industry,
          awareness: detection.awareness,
          funnel: detection.funnel,
          specialist: specialist.id,
        },
        trigger: 'user-request',
        recommendationText:
          `${specialist.name} produced ${route.channel || 'content'} for ` +
          `${detection.awareness}×${detection.funnel}` +
          (refused ? ` — REFUSED: ${refusalReason}` : ''),
        confidence: detection.confidence || 0.5,
        expectedUpside: methodologyScore.aggregate_score
          ? { text: `Methodology score ${methodologyScore.aggregate_score.toFixed(2)}` }
          : null,
        risk: refused ? refusalReason : `manip_risk=${manipulationRiskTotal}/${effectiveCeiling}`,
        costUsd: 0, // agency-pipeline charges via callClaude cost tracker; this row is audit only
        manipulationRisk: manipulationRiskTotal,
        autoSafeBand: refused ? 'red' : manipulationRiskTotal >= effectiveCeiling * 0.8 ? 'yellow' : 'green',
      });
      if (decision?.id) {
        await decisionLog.recordExecution(decision.id, {
          executed: !refused,
          executionDetails: {
            specialist: specialist.id,
            methodologies: methodologyIds,
            generation_chars: generation ? generation.length : 0,
          },
          refused,
          refusalReason,
        });
        result.decision_log_id = decision.id;
        log(`mirrored to decision_logs (id=${decision.id})`);
      }
    } catch (e) {
      log(`decision_logs mirror failed (non-fatal): ${e.message}`);
    }
  }

  return result;
}

function _earlyExit(payload) {
  return Object.assign({ generation: '', prompt_segments: [] }, payload);
}

module.exports = {
  runAgencyPipeline,
  GLOBAL_MANIPULATION_RISK_CEILING,
};
