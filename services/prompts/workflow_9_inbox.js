/*
 * workflow_9_inbox.js — Unified Inbox + Smart Routing prompts (backend-native)
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildInboxTriagePrompt(ctx, thread) {
  const addendum = `
WORKFLOW #9/11 — UNIFIED INBOX + SMART ROUTING

You are the senior customer ops lead. Triage this inbound message. Decide:
  1. What kind of message is it?
  2. Who should handle it?
  3. What's the SLA?
  4. Should AI draft a response, or is this human-only?

OUTPUT JSON
{
  "classification": "lead|support|complaint|spam|partnership|press|internal|review_mention",
  "sentiment": "positive|neutral|negative|critical",
  "urgency": "immediate|high|medium|low",
  "sla_minutes": number,
  "route_to": "sales|support|founder|ops|legal|auto_reply",
  "ai_can_draft": boolean,
  "draft_guidance": "1-sentence voice + tone direction if ai_can_draft",
  "escalation_reason": "string — only if urgency=immediate",
  "frameworks_cited": ["Cialdini reciprocity if gift offered", ...]
}

Never route legal complaints, medical claims, or refund demands over $X to
the AI — those are human-only.
`.trim();

  const user = `
MESSAGE
  Channel: ${thread.channel}
  From: ${thread.from || 'unknown'}
  Subject: ${thread.subject || '(none)'}
  Body: ${thread.body}
  Attachments: ${(thread.attachments || []).length}
  Previous touches: ${thread.previousCount || 0}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

function buildInboxReplyPrompt(ctx, thread, triage) {
  const addendum = `
WORKFLOW #9/11 — INBOX REPLY GENERATION

Draft a reply to this message matching the brand voice and the triage
guidance. 80-200 words. One clear next step.

Return JSON:
{
  "subject_line": "string",
  "body": "string",
  "tone": "string",
  "next_step": "string",
  "requires_human_review": boolean,
  "confidence": 0-1
}
`.trim();

  const user = `
THREAD: ${JSON.stringify(thread).slice(0, 1200)}
TRIAGE: ${JSON.stringify(triage)}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildInboxTriagePrompt = buildInboxTriagePrompt;
module.exports.buildInboxReplyPrompt = buildInboxReplyPrompt;
