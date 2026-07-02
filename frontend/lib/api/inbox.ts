import { api } from './client';

/**
 * lib/api/inbox.ts — client for WF9 (unified inbox) + WF11 (routing / SLA).
 *
 * Honesty notes (verified against services/wf9 + services/wf11; both have ~zero
 * behavioural tests, so this UI is READ-MOSTLY):
 *  - Reads (threads / escalations / metrics / settings) are safe.
 *  - draft-reply GENERATES a suggestion via Claude and persists a draft, but
 *    there is NO send path on the backend — so the UI offers copy, never send.
 *  - There is no seed data: everything is empty until wf9-intake runs (which
 *    has no inbound-channel connector yet), hence the strong empty state.
 *
 * Casing footgun (matches backend): reads take snake_case `business_id`;
 * writes take camelCase `businessId`.
 */

export type InboxChannel = 'email' | 'instagram_dm' | 'whatsapp' | 'facebook' | 'tiktok' | 'form' | string;
export type InboxClassification =
  | 'lead' | 'support' | 'complaint' | 'spam' | 'partnership' | 'press' | 'internal' | 'review_mention' | string;
export type InboxSentiment = 'positive' | 'neutral' | 'negative' | 'critical' | string;
export type InboxUrgency = 'immediate' | 'high' | 'medium' | 'low' | string;
export type InboxStatus = 'new' | 'routed' | 'responded' | 'resolved' | 'escalated' | string;

export interface InboxThread {
  id: string;
  business_id: string;
  channel: InboxChannel;
  external_id?: string | null;
  from_handle?: string | null;
  subject?: string | null;
  body?: string | null;
  attachments?: unknown[];
  classification?: InboxClassification | null;
  sentiment?: InboxSentiment | null;
  urgency?: InboxUrgency | null;
  sla_deadline?: string | null;
  route_to?: string | null;
  status?: InboxStatus | null;
  specialist_role?: string | null;
  escalation_level?: number | null;
  escalated_at?: string | null;
  ai_can_autorespond?: boolean | null;
  created_at: string;
  responded_at?: string | null;
}

export interface InboxEscalation {
  id: string;
  thread_id: string;
  specialist_role?: string | null;
  reason?: string | null;
  level?: number | null;
  resolved_at?: string | null;
  created_at: string;
}

export interface InboxMetrics {
  periodDays: number;
  threadCount: number;
  escalationCount: number;
  bySpecialist: Record<string, { volume: number; escalated: number; resolved: number }>;
  specialists: string[];
}

export interface InboxSettings {
  autonomy_mode?: string;
  deal_escalation_threshold_usd?: number;
  refund_escalation_threshold_usd?: number;
  default_sla_minutes?: number;
  owner_notify_email?: string | null;
  specialist_overrides?: Record<string, unknown>;
  updated_at?: string | null;
}

export interface DraftReply {
  subject_line?: string;
  body: string;
  tone?: string;
  next_step?: string;
  requires_human_review?: boolean;
  confidence?: number;
}

export async function listThreads(
  businessId: string,
  opts: { status?: string; urgency?: string } = {},
): Promise<InboxThread[]> {
  try {
    const r = await api.post<{ items: InboxThread[] }>('/webhook/wf9-threads-list', {
      business_id: businessId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.urgency ? { urgency: opts.urgency } : {}),
    });
    return r.items || [];
  } catch {
    return [];
  }
}

export async function listEscalations(businessId: string): Promise<InboxEscalation[]> {
  try {
    const r = await api.post<{ items: InboxEscalation[] }>('/webhook/wf11-escalations-list', {
      business_id: businessId,
    });
    return r.items || [];
  } catch {
    return [];
  }
}

export async function getInboxMetrics(businessId: string): Promise<InboxMetrics | null> {
  try {
    return await api.post<InboxMetrics>('/webhook/wf11-metrics', { business_id: businessId });
  } catch {
    return null;
  }
}

export async function getInboxSettings(businessId: string): Promise<InboxSettings | null> {
  try {
    return await api.post<InboxSettings>('/webhook/wf11-settings-get', { business_id: businessId });
  } catch {
    return null;
  }
}

/**
 * Generate a suggested reply (Claude). Persists a DRAFT only — the backend has
 * no send path, so callers must offer copy, not send. Throws on failure so the
 * caller can surface a toast.
 */
export async function draftReply(businessId: string, threadId: string): Promise<DraftReply | null> {
  const r = await api.post<{ replyId: string; reply: DraftReply }>('/webhook/wf9-draft-reply', {
    businessId,
    threadId,
  });
  return r.reply || null;
}
