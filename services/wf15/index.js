/*
 * services/wf15/index.js
 * ----------------------------------------------------------------------------
 * WF15 — AI Brain (Conversational Command Center) factory.
 *
 * Responsibilities:
 *   - Conversation + message persistence
 *   - Multimodal attachment handling (Whisper transcription / OCR stubs)
 *   - Model routing (Haiku / Sonnet / Opus) via routeModel from prompt module
 *   - Memory snapshot builder (recent decisions, active strategies, learnings)
 *   - Tool-call dispatch with approval gate enforcement
 *   - Decision log + explain-decision endpoint data
 *   - Proactive morning check-in generation
 *
 * Streaming: this initial implementation returns the full response
 * synchronously (one-shot). SSE streaming can be added later by swapping
 * `callClaude` for a streaming variant — the `streamUrl` the frontend
 * expects is the same URL served as a synchronous response for now (client
 * will fall back to JSON parsing if the content-type isn't text/event-stream).
 * ----------------------------------------------------------------------------
 */

'use strict';

const { randomUUID } = require('node:crypto');
const {
  buildBrainSystemPrompt,
  buildMorningCheckInPrompt,
  buildUrgentAlertPrompt,
  routeModel,
  WF15_GUARDRAILS,
  BRAIN_TOOLS,
} = require('../prompts/workflow_15_ai_brain.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf15(deps) {
  const {
    sbGet, sbPost, sbPatch,
    callClaude, streamClaude, extractJSON,
    logger,
  } = deps;

  async function resolveBrandContext(businessId) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!bizRows[0]) throw new Error(`Business not found: ${businessId}`);
    return buildBrandContext({ business: bizRows[0], profile: profileRows[0] || {} });
  }

  async function buildMemorySnapshot(businessId) {
    // Recent decisions: last 8 brain_decisions rows
    const [decisionsRaw, learningsRaw, memoryRow, approvalsCount, briefRow] = await Promise.all([
      sbGet('brain_decisions', `business_id=eq.${businessId}&order=created_at.desc&limit=8&select=created_at,reasoning,outcome`).catch(() => []),
      sbGet('learning_patterns', `business_id=eq.${businessId}&pattern_type=eq.winning&order=lift.desc&limit=5&select=trait,lift,sample_size`).catch(() => []),
      sbGet('brain_memory', `business_id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('approvals', `business_id=eq.${businessId}&status=eq.pending&select=id`).catch(() => []),
      sbGet('weekly_briefs', `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=id`).catch(() => []),
    ]);

    const mem = memoryRow[0] || {};
    const prefs = mem.owner_preferences || {};

    return {
      recentDecisions: (decisionsRaw || []).map(d => ({
        date: (d.created_at || '').slice(0, 10),
        decision: (d.reasoning || '').slice(0, 140),
        outcome: d.outcome ? JSON.stringify(d.outcome).slice(0, 60) : undefined,
      })),
      activeStrategies: [], // populated from ad_campaigns + content_plans in future
      recentLearnings: (learningsRaw || []).map(l => ({
        pattern: l.trait,
        lift: Number(l.lift || 0) - 1,
        sampleSize: l.sample_size || 0,
      })),
      ownerPreferences: {
        verbosity: prefs.verbosity || 'standard',
        technicalDepth: prefs.technicalDepth || 'intermediate',
        language: prefs.language || 'English',
        topicsOfHighInterest: prefs.topicsOfHighInterest || [],
        recommendationsOftenRejected: prefs.recommendationsOftenRejected || [],
        recommendationsOftenApproved: prefs.recommendationsOftenApproved || [],
      },
      longTermSummary: mem.long_term_summary || undefined,
      lastBriefId: briefRow[0]?.id,
      activeApprovalCount: (approvalsCount || []).length,
    };
  }

  async function listConversations(businessId) {
    const rows = await sbGet(
      'brain_conversations',
      `business_id=eq.${businessId}&order=last_message_at.desc.nullslast&limit=50&select=*`
    ).catch(() => []);
    return rows.map(r => ({
      id: r.id,
      title: r.title || 'New conversation',
      lastMessageAt: r.last_message_at || r.created_at,
      messageCount: r.message_count || 0,
    }));
  }

  async function getConversation({ businessId, conversationId }) {
    const [convRows, msgRows] = await Promise.all([
      sbGet('brain_conversations', `id=eq.${conversationId}&business_id=eq.${businessId}&select=*`).catch(() => []),
      sbGet(
        'brain_messages',
        `conversation_id=eq.${conversationId}&order=created_at.asc&limit=100&select=*`
      ).catch(() => []),
    ]);
    const conv = convRows[0];
    if (!conv) throw new Error('Conversation not found');
    return {
      conversation: {
        id: conv.id,
        title: conv.title || 'New conversation',
        lastMessageAt: conv.last_message_at || conv.created_at,
        messageCount: conv.message_count || 0,
      },
      messages: msgRows.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        attachments: m.attachments || [],
        toolCalls: m.tool_calls || [],
        reasoning: m.reasoning || undefined,
        modelUsed: m.model_used || undefined,
        costUsd: m.cost_usd ? Number(m.cost_usd) : undefined,
        createdAt: m.created_at,
      })),
    };
  }

  async function createConversation({ businessId, initialMessage }) {
    const title = initialMessage ? initialMessage.slice(0, 60) : 'New conversation';
    const row = await sbPost('brain_conversations', {
      business_id: businessId,
      title,
      message_count: 0,
      last_message_at: new Date().toISOString(),
    });
    return { conversationId: row.id };
  }

  async function sendMessage({ businessId, conversationId, content, attachmentIds = [], res }) {
    // Load brand context + memory
    const [brandContext, memory, history] = await Promise.all([
      resolveBrandContext(businessId),
      buildMemorySnapshot(businessId),
      sbGet('brain_messages', `conversation_id=eq.${conversationId}&order=created_at.asc&limit=${WF15_GUARDRAILS.maxContextMessages}&select=role,content`).catch(() => []),
    ]);

    // Persist user message
    const userMsg = await sbPost('brain_messages', {
      conversation_id: conversationId,
      business_id: businessId,
      role: 'user',
      content,
      attachments: [],
      model_used: null,
    });

    // Create placeholder assistant message (will be updated when stream completes)
    const assistantMsg = await sbPost('brain_messages', {
      conversation_id: conversationId,
      business_id: businessId,
      role: 'assistant',
      content: '',
      attachments: [],
      tool_calls: [],
      reasoning: null,
      model_used: null,
    });

    // Send meta event with assistant message ID so frontend can track it
    if (res) {
      res.write(`event: meta\ndata: ${JSON.stringify({ assistantMessageId: assistantMsg.id })}\n\n`);
    }

    // Route model
    const routing = routeModel(content, attachmentIds.length > 0);
    const model =
      routing.model === 'opus' ? 'claude-opus-4-5' :
      routing.model === 'sonnet' ? 'claude-sonnet-4-5' :
      'claude-haiku-4-5';

    // Build prompt
    const system = buildBrainSystemPrompt(brandContext, memory);
    const historyBlock = (history || [])
      .filter(m => m.role !== 'system')
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const userPrompt = `${historyBlock}\n\nUSER: ${content}\n\nASSISTANT:`;

    let fullText = '';
    try {
      if (streamClaude && res) {
        // Real streaming path
        fullText = await streamClaude({
          model,
          system,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 2500,
          businessId,
          onToken: (chunk) => {
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
            }
          },
        });
      } else {
        // Fallback: one-shot (when streamClaude not available or no res)
        fullText = await callClaude(userPrompt, model, 2500, {
          system, businessId, returnRaw: true,
        });
      }
    } catch (e) {
      // Stream error — notify client and save error state
      if (res && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message || 'Stream failed' })}\n\n`);
        res.end();
      }
      await sbPatch('brain_messages', `id=eq.${assistantMsg.id}`, {
        content: `[Error: ${e.message}]`,
        model_used: routing.model,
      }).catch(() => {});
      throw e;
    }

    // Update assistant message with full text
    await sbPatch('brain_messages', `id=eq.${assistantMsg.id}`, {
      content: fullText,
      model_used: routing.model,
    }).catch(e => logger?.warn('/wf15', businessId, 'assistant message update failed', { error: e.message }));

    // Send done event
    if (res && !res.writableEnded) {
      res.write(`data: [DONE]\n\n`);
      res.end();
    }

    // Update conversation metadata
    await sbPatch('brain_conversations', `id=eq.${conversationId}`, {
      message_count: (history.length || 0) + 2,
      last_message_at: new Date().toISOString(),
    }).catch(() => {});

    // Log decision
    await sbPost('brain_decisions', {
      business_id: businessId,
      trigger: 'user',
      input: { conversation_id: conversationId, user_message_id: userMsg.id, content: content.slice(0, 500) },
      reasoning: routing.rationale,
      actions: [],
      model_used: model,
    }).catch(() => {});

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf15.message.sent',
      workflow: '15_ai_brain',
      payload: { conversation_id: conversationId, model_used: routing.model },
      severity: 'info',
    }).catch(() => {});

    return {
      assistantMessageId: assistantMsg.id,
      streamUrl: `/webhook/wf15-stream/${assistantMsg.id}`,
    };
  }

  async function toolDecision({ businessId, toolCallId, decision, edits }) {
    const rows = await sbGet('brain_tool_calls', `id=eq.${toolCallId}&select=*`).catch(() => []);
    const toolCall = rows[0];
    if (!toolCall) throw new Error('Tool call not found');
    if (decision === 'reject') {
      await sbPatch('brain_tool_calls', `id=eq.${toolCallId}`, {
        status: 'rejected',
        completed_at: new Date().toISOString(),
      });
      return { ok: true, status: 'rejected' };
    }
    // approve: mark status completed (actual execution dispatched by workflow-specific code)
    await sbPatch('brain_tool_calls', `id=eq.${toolCallId}`, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: edits ? { ...(toolCall.result || {}), edits } : toolCall.result,
    });
    return { ok: true, status: 'completed' };
  }

  async function explainDecision({ businessId, messageId }) {
    const rows = await sbGet('brain_messages', `id=eq.${messageId}&business_id=eq.${businessId}&select=*`).catch(() => []);
    const msg = rows[0];
    if (!msg) throw new Error('Message not found');
    // Naive explain: ask Claude again with the message content and ask for reasoning extraction
    const brandContext = await resolveBrandContext(businessId);
    const memory = await buildMemorySnapshot(businessId);
    const system = buildBrainSystemPrompt(brandContext, memory);
    const user = `Explain the reasoning behind this past assistant message as a senior strategist teaching a junior. Return JSON:
{
  "decision": "1-sentence summary of what was decided",
  "evidence": ["3 bullet points of supporting evidence"],
  "alternatives": [{"option": "...", "why_rejected": "..."}],
  "nextStep": "what the owner should do next"
}

MESSAGE TO EXPLAIN:
${msg.content}`;
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1500, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};
    return {
      decision: parsed.decision || '',
      evidence: parsed.evidence || [],
      alternatives: parsed.alternatives || [],
      nextStep: parsed.nextStep || '',
    };
  }

  async function getDecisionLog({ businessId, limit = 50, kind, before }) {
    let query = `business_id=eq.${businessId}&order=created_at.desc&limit=${limit}&select=*`;
    if (before) query += `&created_at=lt.${encodeURIComponent(before)}`;
    const rows = await sbGet('brain_decisions', query).catch(() => []);
    return {
      items: rows.map(r => ({
        id: r.id,
        createdAt: r.created_at,
        trigger: r.trigger,
        summary: (r.reasoning || '').slice(0, 140),
        workflow: '15_ai_brain',
        toolsUsed: (r.actions || []).map(a => a.action).filter(Boolean),
        outcome: r.outcome?.status || 'success',
        modelUsed: (r.model_used || 'sonnet').includes('opus') ? 'opus' : (r.model_used || 'sonnet').includes('haiku') ? 'haiku' : 'sonnet',
        costUsd: Number(r.cost_usd || 0),
      })),
      nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null,
    };
  }

  async function generateMorningCheckIn({ businessId }) {
    const [brandContext, memory] = await Promise.all([
      resolveBrandContext(businessId),
      buildMemorySnapshot(businessId),
    ]);
    const { system, user } = buildMorningCheckInPrompt(brandContext, memory);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1000, { system, businessId, returnRaw: true });
    return { text: raw };
  }

  return {
    listConversations,
    getConversation,
    createConversation,
    sendMessage,
    toolDecision,
    explainDecision,
    getDecisionLog,
    generateMorningCheckIn,
    buildMemorySnapshot,
    resolveBrandContext,
  };
}

module.exports = createWf15;
