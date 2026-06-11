import { api } from './client';
import { getSession } from './auth';

/**
 * lib/api/brain.ts — client for the WF15 "AI Brain" (conversational command center).
 *
 * Reality check (verified against services/wf15): the brain is ADVISORY ONLY.
 * It lists/creates conversations, streams a chat reply, and can explain its
 * reasoning. Its 30 declared "tools" (pause campaign, publish, send email, …)
 * do NOT execute anything yet, and /wf15-tool-decision is inert — so the UI
 * ships zero action buttons and labels execution "coming soon".
 *
 * Auth: every /webhook/* route requires the Supabase JWT in the Authorization
 * header (no ?token= accepted). The non-streaming calls go through `api`
 * (which attaches the JWT); the streaming send is a manual fetch (below).
 *
 * Casing footgun (matches backend): list/get/decision-log take snake_case
 * `business_id`; create/send/explain take camelCase `businessId`.
 */
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export type BrainRole = 'user' | 'assistant' | 'system' | 'tool';

export interface BrainConversationSummary {
  id: string;
  title: string;
  lastMessageAt: string | null;
  messageCount: number;
}

export interface BrainMessage {
  id: string;
  role: BrainRole;
  content: string;
  modelUsed?: string;
  createdAt: string;
}

export interface BrainConversationDetail {
  conversation: BrainConversationSummary;
  messages: BrainMessage[];
}

export interface BrainExplanation {
  decision: string;
  evidence: string[];
  alternatives: { option: string; why_rejected: string }[];
  nextStep: string;
}

// ─── Non-streaming JSON endpoints (JWT auto-attached by `api`) ──────────────

export async function listConversations(businessId: string): Promise<BrainConversationSummary[]> {
  try {
    const r = await api.post<{ items: BrainConversationSummary[] }>('/webhook/wf15-conversations', {
      business_id: businessId,
    });
    return r.items || [];
  } catch {
    return [];
  }
}

export async function getConversation(
  businessId: string,
  conversationId: string,
): Promise<BrainConversationDetail | null> {
  try {
    return await api.post<BrainConversationDetail>('/webhook/wf15-conversation-get', {
      business_id: businessId,
      conversation_id: conversationId,
    });
  } catch {
    return null;
  }
}

export async function createConversation(
  businessId: string,
  initialMessage?: string,
): Promise<string | null> {
  try {
    const r = await api.post<{ conversationId: string }>('/webhook/wf15-conversation-create', {
      businessId,
      initialMessage,
    });
    return r.conversationId || null;
  } catch {
    return null;
  }
}

export async function explainMessage(
  businessId: string,
  messageId: string,
): Promise<BrainExplanation | null> {
  try {
    return await api.post<BrainExplanation>('/webhook/wf15-explain', { businessId, messageId });
  } catch {
    return null;
  }
}

// ─── Streaming send (SSE over fetch + ReadableStream) ───────────────────────
// EventSource can't set Authorization and the backend needs the JWT in the
// header, so we POST with fetch and parse SSE frames by hand. Wire format
// (services/wf15/index.js): `event: meta` {assistantMessageId}, then unnamed
// `data: {"text":"<delta>"}` chunks, then unnamed `data: [DONE]`; errors come
// as `event: error` {message}.

export interface StreamHandlers {
  onMeta?: (assistantMessageId: string) => void;
  onToken: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}

export async function sendMessageStream(
  businessId: string,
  conversationId: string,
  content: string,
  handlers: StreamHandlers,
): Promise<void> {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    handlers.onDone();
  };
  const fail = (msg: string) => {
    if (finished) return;
    finished = true;
    handlers.onError(msg);
  };

  let token: string | undefined;
  try {
    token = (await getSession())?.access_token;
  } catch {
    /* ignore */
  }
  if (!token) {
    fail('Your session has expired — please sign in again.');
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL.replace(/\/$/, '')}/webhook/wf15-send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ businessId, conversationId, content }),
      signal: handlers.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      finished = true;
      return;
    }
    fail('Could not reach the Brain. Check your connection and try again.');
    return;
  }

  if (!res.ok || !res.body) {
    fail(`The Brain is unavailable right now (${res.status}).`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processFrame = (frame: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const raw of frame.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data) return;

    if (event === 'meta') {
      try {
        const j = JSON.parse(data);
        if (j.assistantMessageId) handlers.onMeta?.(j.assistantMessageId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (event === 'error') {
      let msg = 'The Brain hit an error.';
      try {
        msg = JSON.parse(data).message || msg;
      } catch {
        /* ignore */
      }
      fail(msg);
      return;
    }
    if (data === '[DONE]') {
      finish();
      return;
    }
    try {
      const j = JSON.parse(data);
      if (typeof j.text === 'string') handlers.onToken(j.text);
    } catch {
      /* non-JSON keep-alive — ignore */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) processFrame(frame);
        if (finished) return;
      }
    }
    if (buffer.trim()) processFrame(buffer);
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      finished = true;
      return;
    }
    fail('The connection was interrupted.');
    return;
  }
  finish();
}
