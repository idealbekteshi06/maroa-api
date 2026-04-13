/*
 * services/wf7/index.js — Email Lifecycle engine
 */

'use strict';

const { buildSequencePlanPrompt } = require('../prompts/workflow_7_email.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf7(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, sendEmail, logger } = deps;

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

  async function designSequence({ businessId, segmentId }) {
    const brandContext = await resolveBrandContext(businessId);
    const segRows = await sbGet('email_segments', `id=eq.${segmentId}&business_id=eq.${businessId}&select=*`);
    const seg = segRows[0];
    if (!seg) throw new Error('Segment not found');
    const { system, user } = buildSequencePlanPrompt(brandContext, {
      name: seg.name,
      size: seg.size_cached,
      signals: seg.definition?.signals || [],
      lifecycleStage: seg.lifecycle_stage,
    });
    const raw = await callClaude(user, 'claude-sonnet-4-5', 4000, { system, businessId, returnRaw: true });
    const plan = extractJSON(raw) || {};
    const row = await sbPost('email_sequences', {
      business_id: businessId,
      segment_id: segmentId,
      name: plan.sequence_name || seg.name,
      status: 'draft',
      plan,
    });
    return { sequenceId: row.id, plan };
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

  async function dispatchDue({ businessId }) {
    // Simple dispatch: find active enrollments whose last_sent_at is > plan delay days ago
    const enrolls = await sbGet('email_enrollments', `business_id=eq.${businessId}&status=eq.active&select=*&limit=100`).catch(() => []);
    const results = [];
    for (const e of enrolls) {
      try {
        const seqRows = await sbGet('email_sequences', `id=eq.${e.sequence_id}&select=*`);
        const seq = seqRows[0];
        if (!seq?.plan?.emails) continue;
        const currentEmail = seq.plan.emails.find(em => em.stage === e.current_stage);
        if (!currentEmail) continue;

        const lastSent = e.last_sent_at ? new Date(e.last_sent_at).getTime() : new Date(e.enrolled_at).getTime();
        const dueAt = lastSent + (Number(currentEmail.delay_days || 0) * 86400000);
        if (Date.now() < dueAt) continue;

        // Get contact email
        const contactRows = await sbGet('contacts', `id=eq.${e.contact_id}&select=email,first_name`);
        const contact = contactRows[0];
        if (!contact?.email) continue;

        if (sendEmail) {
          await sendEmail(contact.email, currentEmail.subject_line, currentEmail.body_html || currentEmail.body_plain || '');
        }

        const nextStage = e.current_stage + 1;
        const isLast = nextStage > seq.plan.emails.length;
        await sbPatch('email_enrollments', `id=eq.${e.id}`, {
          current_stage: nextStage,
          last_sent_at: new Date().toISOString(),
          status: isLast ? 'completed' : 'active',
        });
        await sbPatch('email_sequences', `id=eq.${seq.id}`, {
          emails_sent: (seq.emails_sent || 0) + 1,
        });
        results.push({ enrollmentId: e.id, emailStage: e.current_stage, ok: true });
      } catch (err) {
        results.push({ enrollmentId: e.id, ok: false, error: err.message });
      }
    }
    return { dispatched: results.length, results };
  }

  return { createSegment, designSequence, enrollContact, dispatchDue, resolveBrandContext };
}

module.exports = createWf7;
