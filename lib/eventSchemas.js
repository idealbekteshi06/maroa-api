'use strict';

/**
 * lib/eventSchemas.js
 * ----------------------------------------------------------------------------
 * Zod schemas for JSONB payloads stored in events / approvals /
 * brain_decisions / decision_log / cold_start_runs.phase_results.
 *
 * Why: these columns were `jsonb` without validation. A typo in a producer
 * (e.g. `review_id_typo` instead of `review_id`) silently writes garbage;
 * downstream `payload.review_id` is `undefined` and the next handler
 * throws with a useless stack. Audit 2026-05-18 H5 hardening.
 *
 * Migration 070 adds a CHECK constraint requiring `payload->>'kind'` for
 * the `events` table — the only DB-level safety net we can ship without
 * touching every producer at once.
 *
 * Validators are forgiving by default: extra keys are allowed (`passthrough`)
 * so adding a new field to a producer doesn't break the validator for old
 * consumers. Required keys are strictly enforced.
 *
 * Usage:
 *   const { validateEventPayload } = require('./lib/eventSchemas');
 *   const validated = validateEventPayload({ kind: 'wf4.review.posted', ... });
 *   await sbPost('events', { kind: validated.kind, payload: validated });
 * ----------------------------------------------------------------------------
 */

const { z } = require('zod');

const uuid = z.string().uuid();
const isoTs = z.string().datetime({ offset: true }).or(z.string());

// ─── Event payloads (events.payload) ──────────────────────────────────────

const EventKindSchema = z.string().min(3).max(120).regex(/^[a-z0-9._-]+$/);

// Strict schemas by kind. Extend as new kinds are introduced.
const EventPayloadByKind = {
  // wf-series events
  'wf1.plan.created': z.object({
    plan_id: uuid,
    business_id: uuid,
    concept_count: z.number().int().nonnegative().optional(),
  }),
  'wf1.content.generated': z.object({
    content_id: uuid,
    business_id: uuid,
    surface: z.string().max(60).optional(),
  }),
  'wf3.signup.received': z.object({
    business_id: uuid,
    user_id: uuid,
    plan: z.string().max(40).optional(),
  }),
  'wf4.response.posted': z.object({
    review_id: uuid,
    draft_id: uuid.optional(),
  }),
  'wf4.response.published': z.object({
    review_id: uuid,
    draft_id: uuid,
  }),
  'ad-optimizer.decision': z.object({
    business_id: uuid,
    campaign_id: z.string().min(1),
    decision: z.enum(['scale', 'pause', 'keep', 'optimize', 'refresh_creative']),
    score: z.number().min(0).max(100).optional(),
  }),
  'creative.refresh.triggered': z.object({
    business_id: uuid,
    campaign_id: z.string().min(1),
    trigger: z.enum(['low_ctr', 'fatigue', 'manual', 'experiment']),
  }),
};

const GenericEventSchema = z
  .object({
    kind: EventKindSchema,
  })
  .passthrough();

function validateEventPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('event_payload_must_be_object');
  }
  const kind = payload.kind;
  if (typeof kind !== 'string' || !kind.trim()) {
    throw new Error('event_payload_kind_required');
  }
  // Validate the kind format up front so we surface the same error whether
  // the kind is known or unknown.
  EventKindSchema.parse(kind);
  const strict = EventPayloadByKind[kind];
  if (strict) {
    // Strict per-kind shape — does NOT passthrough extras to enforce
    // contract producers actually use. Add fields to the schema first.
    return strict.passthrough().parse(payload);
  }
  // Unknown kind — accept but require it's at least a string with kind.
  return GenericEventSchema.parse(payload);
}

// ─── Approval payloads (approvals.payload) ────────────────────────────────

const ApprovalPayloadSchema = z
  .object({
    business_id: uuid,
    surface: z.string().min(1).max(60),
    target_id: z.string().min(1).max(200), // generated_content.id, ad_audit.id, etc.
    requested_by: z.string().max(120).optional(),
    requested_at: isoTs.optional(),
  })
  .passthrough();

function validateApprovalPayload(payload) {
  return ApprovalPayloadSchema.parse(payload);
}

// ─── Decision log entries (decision_logs.context) ─────────────────────────

const DecisionLogContextSchema = z
  .object({
    agent: z.string().min(1).max(80),
    business_id: uuid.optional(),
    decision: z.string().min(1).max(400),
    confidence: z.number().min(0).max(1).optional(),
    inputs: z.record(z.any()).optional(),
    outputs: z.record(z.any()).optional(),
  })
  .passthrough();

function validateDecisionLogContext(payload) {
  return DecisionLogContextSchema.parse(payload);
}

// ─── Cold-start run phase result ─────────────────────────────────────────

const ColdStartPhaseResultSchema = z
  .object({
    phase: z.string().min(1).max(80),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']),
    started_at: isoTs.optional(),
    completed_at: isoTs.optional(),
    error: z.string().max(2000).nullable().optional(),
  })
  .passthrough();

function validateColdStartPhase(payload) {
  return ColdStartPhaseResultSchema.parse(payload);
}

module.exports = {
  EventPayloadByKind,
  EventKindSchema,
  GenericEventSchema,
  ApprovalPayloadSchema,
  DecisionLogContextSchema,
  ColdStartPhaseResultSchema,
  validateEventPayload,
  validateApprovalPayload,
  validateDecisionLogContext,
  validateColdStartPhase,
};
