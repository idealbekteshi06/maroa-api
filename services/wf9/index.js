/*
 * services/wf9/index.js — Unified Inbox + Smart Routing engine
 */

'use strict';

const { buildInboxTriagePrompt, buildInboxReplyPrompt } = require('../prompts/workflow_9_inbox.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf9(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function intakeThread({ businessId, channel, externalId, fromHandle, subject, body, attachments = [] }) {
    const thread = await sbPost('inbox_threads', {
      business_id: businessId,
      channel,
      external_id: externalId || null,
      from_handle: fromHandle || null,
      subject: subject || null,
      body: body || '',
      attachments,
      status: 'new',
    });
    // Kick triage inline
    const triage = await triageThread({ businessId, threadId: thread.id });
    return { threadId: thread.id, ...triage };
  }

  async function triageThread({ businessId, threadId }) {
    const threadRows = await sbGet('inbox_threads', `id=eq.${threadId}&business_id=eq.${businessId}&select=*`);
    const thread = threadRows[0];
    if (!thread) throw new Error('Thread not found');

    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildInboxTriagePrompt(brandContext, {
      channel: thread.channel,
      from: thread.from_handle,
      subject: thread.subject,
      body: thread.body,
      attachments: thread.attachments,
      previousCount: 0,
    });
    const raw = await callClaude(user, 'claude-haiku-4-5', 800, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const slaMinutes = Number(parsed.sla_minutes || 240);
    await sbPatch('inbox_threads', `id=eq.${threadId}`, {
      classification: parsed.classification || 'support',
      sentiment: parsed.sentiment || 'neutral',
      urgency: parsed.urgency || 'medium',
      sla_deadline: new Date(Date.now() + slaMinutes * 60000).toISOString(),
      route_to: parsed.route_to || 'support',
      status: 'routed',
    });

    // Auto-draft if allowed
    if (parsed.ai_can_draft) {
      await draftReply({ businessId, threadId, triage: parsed }).catch(() => {});
    }

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf9.thread.triaged',
      workflow: '9_inbox',
      payload: { thread_id: threadId, classification: parsed.classification, urgency: parsed.urgency },
      severity: parsed.urgency === 'immediate' ? 'warn' : 'info',
    }).catch(() => {});

    return parsed;
  }

  async function draftReply({ businessId, threadId, triage }) {
    const threadRows = await sbGet('inbox_threads', `id=eq.${threadId}&business_id=eq.${businessId}&select=*`);
    const thread = threadRows[0];
    if (!thread) throw new Error('Thread not found');

    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildInboxReplyPrompt(brandContext, {
      channel: thread.channel,
      subject: thread.subject,
      body: thread.body,
    }, triage || { classification: thread.classification, urgency: thread.urgency });
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1200, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const row = await sbPost('inbox_replies', {
      thread_id: threadId,
      business_id: businessId,
      body: parsed.body || '',
      subject: parsed.subject_line || thread.subject,
      tone: parsed.tone || 'warm',
      requires_human_review: parsed.requires_human_review !== false,
      confidence: Number(parsed.confidence || 0.7),
      status: 'draft',
    });
    return { replyId: row.id, reply: parsed };
  }

  async function listThreads({ businessId, status, urgency, limit = 50 }) {
    let query = `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=*`;
    if (status) query += `&status=eq.${encodeURIComponent(status)}`;
    if (urgency) query += `&urgency=eq.${encodeURIComponent(urgency)}`;
    const rows = await sbGet('inbox_threads', query).catch(() => []);
    return { items: rows };
  }

  return { intakeThread, triageThread, draftReply, listThreads, resolveBrandContext };
}

module.exports = createWf9;
