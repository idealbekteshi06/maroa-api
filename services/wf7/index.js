/*
 * services/wf7/index.js — Email Lifecycle engine (DEPRECATED)
 *
 * @deprecated Superseded by the canonical services/email-lifecycle (firing
 * Inngest cron `email-lifecycle-process-15m` + GET /api/business/:id/email-lifecycle
 * + /webhook/email-lifecycle-{enroll,bootstrap,process-due}). See
 * CANONICAL_WORKFLOWS.md. Marked-deprecated — do NOT build new features on it.
 *
 * Double-writer fix: designSequence + dispatchDue NO LONGER read or write the
 * shared `email_sequences` table (now owned exclusively by email-lifecycle).
 * They are inert deprecation stubs. createSegment / enrollContact still use
 * wf7's own email_segments / email_enrollments tables, which do not collide
 * with the canonical engine.
 */

'use strict';

const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf7(deps) {
  const { sbGet, sbPost } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function createSegment({ businessId, name, definition, lifecycleStage }) {
    const row = await sbPost('email_segments', {
      business_id: businessId,
      name,
      definition: definition || {},
      lifecycle_stage: lifecycleStage || 'new',
      size_cached: 0,
    });
    return { segmentId: row.id };
  }

  // @deprecated — no longer writes the shared `email_sequences` table (owned by
  // services/email-lifecycle). Returns a deprecation signal rather than forking
  // the sequence data model with a divergent {segment_id, plan} shape.
  async function designSequence({ businessId, segmentId }) {
    return {
      ok: false,
      deprecated: true,
      use: 'services/email-lifecycle',
      message:
        'wf7.designSequence is deprecated and no longer writes email_sequences. ' +
        'Use the canonical email-lifecycle engine (POST /webhook/email-lifecycle-bootstrap).',
      businessId,
      segmentId,
    };
  }

  async function enrollContact({ businessId, sequenceId, contactId }) {
    const row = await sbPost('email_enrollments', {
      business_id: businessId,
      sequence_id: sequenceId,
      contact_id: contactId,
      current_stage: 1,
      status: 'active',
    });
    return { enrollmentId: row.id };
  }

  // @deprecated — no longer reads or patches the shared `email_sequences` table.
  // The canonical email-lifecycle cron (processDueRuns) dispatches due emails.
  async function dispatchDue({ businessId }) {
    return {
      ok: false,
      deprecated: true,
      use: 'services/email-lifecycle',
      message:
        'wf7.dispatchDue is deprecated. The canonical email-lifecycle cron ' +
        '(/webhook/email-lifecycle-process-due) dispatches due emails.',
      businessId,
      dispatched: 0,
      results: [],
    };
  }

  return { createSegment, designSequence, enrollContact, dispatchDue, resolveBrandContext };
}

module.exports = createWf7;
