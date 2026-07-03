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
const { TOOL_SCHEMAS, TOOLS, executeTool } = require('./toolRegistry.js');

function createWf15(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, streamClaude, extractJSON, logger } = deps;

  // Internal loopback to our own /webhook/* routes. These pass
  // requireAuthOrWebhookSecret via the x-webhook-secret header, so the AI Brain
  // can drive the whole app without a user JWT. Returns parsed JSON; throws on
  // non-2xx so executeTool can convert it to a { error } tool_result.
  function makeLoopback(businessId) {
    const port = process.env.PORT || 3000;
    const base = `http://127.0.0.1:${port}`;
    const secret = process.env.N8N_WEBHOOK_SECRET;
    async function loopback(method, path, body) {
      const res = await globalThis.fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-webhook-secret': secret,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }
      if (!res.ok) {
        const msg = parsed?.error || parsed?.message || `HTTP ${res.status}`;
        throw new Error(String(msg).slice(0, 300));
      }
      return parsed;
    }
    return { businessId, loopback, logger };
  }

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
      sbGet(
        'brain_decisions',
        `business_id=eq.${businessId}&order=created_at.desc&limit=8&select=created_at,reasoning,outcome`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.winning&order=lift.desc&limit=5&select=trait,lift,sample_size`
      ).catch(() => []),
      sbGet('brain_memory', `business_id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('approvals', `business_id=eq.${businessId}&status=eq.pending&select=id`).catch(() => []),
      sbGet('weekly_briefs', `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=id`).catch(() => []),
    ]);

    const mem = memoryRow[0] || {};
    const prefs = mem.owner_preferences || {};

    return {
      recentDecisions: (decisionsRaw || []).map((d) => ({
        date: (d.created_at || '').slice(0, 10),
        decision: (d.reasoning || '').slice(0, 140),
        outcome: d.outcome ? JSON.stringify(d.outcome).slice(0, 60) : undefined,
      })),
      activeStrategies: [], // populated from ad_campaigns + content_plans in future
      recentLearnings: (learningsRaw || []).map((l) => ({
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
    return rows.map((r) => ({
      id: r.id,
      title: r.title || 'New conversation',
      lastMessageAt: r.last_message_at || r.created_at,
      messageCount: r.message_count || 0,
    }));
  }

  async function getConversation({ businessId, conversationId }) {
    const [convRows, msgRows] = await Promise.all([
      sbGet('brain_conversations', `id=eq.${conversationId}&business_id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('brain_messages', `conversation_id=eq.${conversationId}&order=created_at.asc&limit=100&select=*`).catch(
        () => []
      ),
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
      messages: msgRows.map((m) => ({
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
      sbGet(
        'brain_messages',
        `conversation_id=eq.${conversationId}&order=created_at.asc&limit=${WF15_GUARDRAILS.maxContextMessages}&select=role,content`
      ).catch(() => []),
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
      routing.model === 'opus'
        ? 'claude-opus-4-7'
        : routing.model === 'sonnet'
          ? 'claude-sonnet-4-5'
          : 'claude-haiku-4-5';

    // Build prompt
    const system = buildBrainSystemPrompt(brandContext, memory);

    // Agentic message array: prior turns as plain-string content, then this turn.
    const messages = (history || [])
      .filter((m) => m.role !== 'system' && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) }));
    messages.push({ role: 'user', content });

    const ctx = makeLoopback(businessId);
    const write = (s) => {
      if (res && !res.writableEnded) res.write(s);
    };

    let fullText = '';
    let stoppedForApproval = false;
    try {
      for (let iter = 0; iter < 6; iter++) {
        const resp = await callClaude('', model, 2500, {
          system,
          messages,
          extraTools: TOOL_SCHEMAS,
          toolChoice: { type: 'auto' },
          returnFullResponse: true,
          businessId,
          skill: 'wf15_brain',
          skipGrounding: true,
        });

        const blocks = Array.isArray(resp?.content) ? resp.content : [];

        // Stream text blocks to the client + accumulate.
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) {
            fullText += block.text;
            write(`data: ${JSON.stringify({ text: block.text })}\n\n`);
          }
        }

        const toolUses = blocks.filter((b) => b?.type === 'tool_use');
        if (resp?.stop_reason !== 'tool_use' || toolUses.length === 0) {
          break; // final turn — no tools requested
        }

        // Keep the Anthropic contract intact: the assistant turn (incl. its
        // tool_use blocks) must be appended before any tool_result turns.
        messages.push({ role: 'assistant', content: resp.content });

        for (const tu of toolUses) {
          const spec = TOOLS[tu.name];
          const inputSummary = spec ? spec.summarize(tu.input) : tu.name;
          const requiresApproval = spec ? spec.approval : true;

          // Persist the tool-call row.
          const row = await sbPost('brain_tool_calls', {
            message_id: assistantMsg.id,
            business_id: businessId,
            tool: tu.name,
            input: tu.input || {},
            input_summary: inputSummary,
            status: requiresApproval ? 'awaiting_approval' : 'running',
            rationale: fullText.slice(-280) || null,
            requires_approval: requiresApproval,
            started_at: new Date().toISOString(),
          }).catch(() => null);

          const rowId = row?.id || tu.id;

          // Emit the tool_call card.
          write(
            `event: tool_call\ndata: ${JSON.stringify({
              toolCall: {
                id: rowId,
                tool: tu.name,
                inputSummary,
                status: requiresApproval ? 'awaiting_approval' : 'running',
                requiresApproval,
                rationale: fullText.slice(-280) || undefined,
                startedAt: new Date().toISOString(),
              },
            })}\n\n`
          );

          if (requiresApproval) {
            // Gated — the user must approve. End the turn here; toolDecision()
            // executes on approve. (Simplest correct behavior per spec.)
            stoppedForApproval = true;
            continue;
          }

          // Auto-run safe tool.
          write(`event: tool_update\ndata: ${JSON.stringify({ id: rowId, status: 'running' })}\n\n`);
          const result = await executeTool(tu.name, tu.input, ctx);
          const status = result && result.error ? 'failed' : 'completed';
          await sbPatch('brain_tool_calls', `id=eq.${rowId}&business_id=eq.${businessId}`, {
            status,
            result,
            completed_at: new Date().toISOString(),
          }).catch(() => {});
          write(`event: tool_result\ndata: ${JSON.stringify({ id: rowId, result, status })}\n\n`);

          // Feed the result back to Claude for the next iteration. Blind
          // .slice() on the JSON string cut it mid-token, so Claude saw
          // malformed data; truncate gracefully with an explicit marker so the
          // model knows the payload was cut rather than reading garbage.
          const fullResult = JSON.stringify(result);
          const resultContent =
            fullResult.length > 4000
              ? fullResult.slice(0, 3900) + `… [truncated ${fullResult.length - 3900} chars]`
              : fullResult;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: tu.id,
                content: resultContent,
              },
            ],
          });
        }

        if (stoppedForApproval) break;
      }
    } catch (e) {
      // Surface Anthropic credit-exhaustion / any loop error cleanly.
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
    }).catch((e) => logger?.warn('/wf15', businessId, 'assistant message update failed', { error: e.message }));

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
      // business_id is REQUIRED by the hardened /webhook/wf15-stream handler
      // (it scopes the brain_messages read by tenant). The EventSource opens
      // this URL verbatim, so it must carry the business_id.
      streamUrl: `/webhook/wf15-stream/${assistantMsg.id}?business_id=${encodeURIComponent(businessId)}`,
    };
  }

  async function toolDecision({ businessId, toolCallId, decision, edits }) {
    // Scope by business_id so a caller can't approve/reject another tenant's
    // tool call by id (brain_tool_calls has a business_id column, migration 026).
    const encTool = encodeURIComponent(toolCallId);
    const encBiz = encodeURIComponent(businessId);
    const scope = `id=eq.${encTool}&business_id=eq.${encBiz}`;
    const rows = await sbGet('brain_tool_calls', `${scope}&select=*`).catch(() => []);
    const toolCall = rows[0];
    if (!toolCall) throw new Error('Tool call not found');
    if (decision === 'reject') {
      await sbPatch('brain_tool_calls', scope, {
        status: 'rejected',
        completed_at: new Date().toISOString(),
      });
      return { ok: true, status: 'rejected' };
    }

    // approve: actually run the gated tool now. `edits` lets the owner tweak the
    // proposed input before it executes.
    const input = edits && typeof edits === 'object' ? { ...(toolCall.input || {}), ...edits } : toolCall.input || {};
    const ctx = makeLoopback(businessId);
    const result = await executeTool(toolCall.tool, input, ctx);
    const status = result && result.error ? 'failed' : 'completed';
    await sbPatch('brain_tool_calls', scope, {
      status,
      result,
      completed_at: new Date().toISOString(),
    });
    return { ok: true, status, result };
  }

  async function explainDecision({ businessId, messageId }) {
    const rows = await sbGet('brain_messages', `id=eq.${messageId}&business_id=eq.${businessId}&select=*`).catch(
      () => []
    );
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
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        trigger: r.trigger,
        summary: (r.reasoning || '').slice(0, 140),
        workflow: '15_ai_brain',
        toolsUsed: (r.actions || []).map((a) => a.action).filter(Boolean),
        outcome: r.outcome?.status || 'success',
        modelUsed: (r.model_used || 'sonnet').includes('opus')
          ? 'opus'
          : (r.model_used || 'sonnet').includes('haiku')
            ? 'haiku'
            : 'sonnet',
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
