'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Mailbox,
  Inbox as InboxIcon,
  AlertTriangle,
  ArrowRight,
  Loader2,
  Sparkles,
  Copy,
  ShieldAlert,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { friendlyTime } from '@/lib/translate';
import {
  listThreads,
  listEscalations,
  getInboxMetrics,
  getInboxSettings,
  draftReply,
  type InboxThread,
  type InboxMetrics,
  type InboxSettings,
  type DraftReply,
} from '@/lib/api/inbox';

/**
 * components/dashboard/inbox/inbox-shell.tsx
 * ---------------------------------------------------------------------------
 * Read-mostly unified inbox (WF9/WF11). Surfaces threads, triage, routing and
 * SLA from real read endpoints. The only write exposed is "Suggest a reply"
 * (Claude draft) — and since the backend has NO send path, the UI offers copy,
 * never send. Intake / resolve / settings-save are not exposed (untested
 * writes). An honest banner sets expectations; there's no seed data, so the
 * empty state is the primary surface for most businesses today.
 * ---------------------------------------------------------------------------
 */

interface Props {
  businessId: string | null;
}

const STATUS_FILTERS = ['new', 'routed', 'responded', 'escalated', 'resolved'] as const;
const URGENCY_FILTERS = ['immediate', 'high', 'medium', 'low'] as const;

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  instagram_dm: 'Instagram DM',
  whatsapp: 'WhatsApp',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  form: 'Web form',
};

const SENTIMENT_TONE: Record<string, 'green' | 'amber' | 'red' | 'muted'> = {
  positive: 'green',
  neutral: 'muted',
  negative: 'amber',
  critical: 'red',
};
const URGENCY_TONE: Record<string, 'green' | 'amber' | 'red' | 'muted'> = {
  immediate: 'red',
  high: 'amber',
  medium: 'muted',
  low: 'muted',
};
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'muted' | 'accent'> = {
  new: 'accent',
  routed: 'muted',
  responded: 'green',
  resolved: 'green',
  escalated: 'red',
};

function labelize(v?: string | null): string {
  if (!v) return '';
  return v.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function Chip({
  tone = 'muted',
  children,
}: {
  tone?: 'green' | 'amber' | 'red' | 'muted' | 'accent';
  children: React.ReactNode;
}) {
  const styles = {
    green: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300',
    amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
    red: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
    accent: 'bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-300',
    muted: 'bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300',
  } as const;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', styles[tone])}>
      {children}
    </span>
  );
}

function slaInfo(thread: InboxThread): { text: string; tone: 'green' | 'amber' | 'red' | 'muted' } | null {
  if (!thread.sla_deadline) return null;
  const done = thread.status === 'responded' || thread.status === 'resolved';
  if (done) return { text: 'SLA met', tone: 'green' };
  const ms = new Date(thread.sla_deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return { text: 'SLA breached', tone: 'red' };
  const mins = Math.round(ms / 60000);
  const text = mins >= 60 ? `SLA in ${Math.round(mins / 60)}h` : `SLA in ${mins}m`;
  return { text, tone: mins <= 30 ? 'amber' : 'muted' };
}

export function InboxShell({ businessId }: Props) {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [metrics, setMetrics] = useState<InboxMetrics | null>(null);
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [openEscalations, setOpenEscalations] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [urgencyFilter, setUrgencyFilter] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    if (!businessId) return;
    setLoadingThreads(true);
    const items = await listThreads(businessId, {
      status: statusFilter ?? undefined,
      urgency: urgencyFilter ?? undefined,
    });
    setThreads(items);
    setLoadingThreads(false);
  }, [businessId, statusFilter, urgencyFilter]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    (async () => {
      const [m, s, esc] = await Promise.all([
        getInboxMetrics(businessId),
        getInboxSettings(businessId),
        listEscalations(businessId),
      ]);
      if (cancelled) return;
      setMetrics(m);
      setSettings(s);
      setOpenEscalations(esc.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (!businessId) {
    return (
      <div className="mx-auto max-w-xl text-center py-12">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 dark:bg-accent-900/30 text-accent-500 mb-4">
          <Mailbox className="h-6 w-6" />
        </span>
        <h2 className="text-xl font-semibold text-ink-700 dark:text-ink-50">Your unified inbox</h2>
        <p className="mt-3 text-ink-500 dark:text-ink-300 leading-relaxed">
          Finish setting up your business profile and Maroa will triage, route, and draft replies for
          every customer message here.
        </p>
        <Link
          href="/onboarding"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent-500 text-white px-5 py-2.5 text-sm font-semibold hover:shadow-card transition-shadow"
        >
          Finish setup
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  const active = threads.find((t) => t.id === activeId) ?? null;

  return (
    <div className="space-y-5">
      {/* Honesty banner */}
      <div className="flex items-start gap-2.5 rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/70 dark:bg-ink-950/40 px-4 py-3">
        <InboxIcon className="h-4 w-4 mt-0.5 text-ink-400 shrink-0" aria-hidden="true" />
        <p className="text-xs text-ink-500 dark:text-ink-300 leading-relaxed">
          Maroa triages, routes, and SLA-tracks messages automatically. Connecting inbound channels
          (email, Instagram DM, WhatsApp…) and <span className="font-medium text-ink-600 dark:text-ink-200">sending
          replies from Maroa</span> are <span className="font-medium text-ink-600 dark:text-ink-200">coming soon</span> —
          for now you can review, see the AI’s reasoning, and copy a suggested reply.
        </p>
      </div>

      {/* Stats strip (metrics + settings reads) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Messages · 7 days" value={metrics ? String(metrics.threadCount) : '—'} />
        <Stat
          label="Open escalations"
          value={String(openEscalations)}
          tone={openEscalations > 0 ? 'red' : 'muted'}
        />
        <Stat label="Autonomy" value={settings?.autonomy_mode ? labelize(settings.autonomy_mode) : 'Hybrid'} />
        <Stat
          label="Default SLA"
          value={settings?.default_sla_minutes ? `${settings.default_sla_minutes}m` : '—'}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterGroup
          options={STATUS_FILTERS as unknown as string[]}
          active={statusFilter}
          onChange={setStatusFilter}
        />
        <span className="hidden sm:inline text-ink-300 dark:text-ink-700">·</span>
        <FilterGroup
          options={URGENCY_FILTERS as unknown as string[]}
          active={urgencyFilter}
          onChange={setUrgencyFilter}
        />
      </div>

      {/* Two-pane */}
      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-4 min-h-[420px]">
        {/* Thread list */}
        <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden flex flex-col">
          {loadingThreads ? (
            <div className="flex items-center justify-center py-16 text-ink-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : threads.length === 0 ? (
            <EmptyThreads filtered={!!(statusFilter || urgencyFilter)} />
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800 overflow-y-auto">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(t.id)}
                    className={cn(
                      'w-full text-left px-4 py-3 transition-colors',
                      t.id === activeId
                        ? 'bg-ink-100/70 dark:bg-ink-800/60'
                        : 'hover:bg-ink-50 dark:hover:bg-ink-800/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-ink-500 dark:text-ink-300 truncate">
                        {t.from_handle || 'Unknown sender'}
                      </span>
                      <span className="text-[10px] text-ink-400 shrink-0">{friendlyTime(t.created_at)}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-medium text-ink-700 dark:text-ink-100 truncate">
                      {t.subject || t.body?.slice(0, 60) || '(no subject)'}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <Chip>{CHANNEL_LABELS[t.channel as string] || labelize(t.channel)}</Chip>
                      {t.urgency && <Chip tone={URGENCY_TONE[t.urgency] || 'muted'}>{labelize(t.urgency)}</Chip>}
                      {t.status === 'escalated' && (
                        <Chip tone="red">
                          <ShieldAlert className="h-3 w-3" /> Escalated
                        </Chip>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Detail */}
        <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden">
          {active ? (
            <ThreadDetail businessId={businessId} thread={active} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center px-6">
              <InboxIcon className="h-8 w-8 text-ink-300 dark:text-ink-600 mb-3" />
              <p className="text-sm text-ink-500 dark:text-ink-300">
                {threads.length === 0 ? 'Nothing to show yet.' : 'Select a message to see its triage and routing.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'muted' | 'red' }) {
  return (
    <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-ink-400 font-medium">{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold',
          tone === 'red' ? 'text-red-600 dark:text-red-400' : 'text-ink-700 dark:text-ink-50',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function FilterGroup({
  options,
  active,
  onChange,
}: {
  options: string[];
  active: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = active === o;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(on ? null : o)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
              on
                ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-300'
                : 'border-ink-200/70 dark:border-ink-700 text-ink-500 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800',
            )}
          >
            {labelize(o)}
          </button>
        );
      })}
    </div>
  );
}

function EmptyThreads({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center px-6">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-ink-100 dark:bg-ink-800 text-ink-400 mb-3">
        <Mailbox className="h-5 w-5" />
      </span>
      {filtered ? (
        <p className="text-sm text-ink-500 dark:text-ink-300">No messages match these filters.</p>
      ) : (
        <>
          <p className="text-sm font-medium text-ink-700 dark:text-ink-100">No messages yet</p>
          <p className="mt-1 text-xs text-ink-500 dark:text-ink-300 leading-relaxed max-w-xs">
            Once inbound channels are connected (coming soon), every email and DM lands here —
            triaged, routed, and SLA-tracked automatically.
          </p>
        </>
      )}
    </div>
  );
}

function ThreadDetail({ businessId, thread }: { businessId: string; thread: InboxThread }) {
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<DraftReply | null>(null);
  const sla = slaInfo(thread);

  // Reset the suggestion when switching threads.
  useEffect(() => {
    setDraft(null);
    setDrafting(false);
  }, [thread.id]);

  async function suggest() {
    setDrafting(true);
    try {
      const r = await draftReply(businessId, thread.id);
      if (!r) throw new Error('No draft returned.');
      setDraft(r);
    } catch (e) {
      toast.error("Couldn't draft a reply", { description: errorMessage(e, 'This is still in beta — try again.') });
    } finally {
      setDrafting(false);
    }
  }

  async function copyDraft() {
    if (!draft?.body) return;
    try {
      await navigator.clipboard.writeText(
        [draft.subject_line ? `Subject: ${draft.subject_line}` : '', draft.body].filter(Boolean).join('\n\n'),
      );
      toast.success('Copied to clipboard');
    } catch {
      toast.error("Couldn't copy");
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-500 dark:text-ink-300">
              {CHANNEL_LABELS[thread.channel as string] || labelize(thread.channel)} ·{' '}
              {thread.from_handle || 'Unknown sender'}
            </span>
            <span className="text-[11px] text-ink-400">{friendlyTime(thread.created_at)}</span>
          </div>
          <h3 className="mt-1 text-base font-semibold text-ink-700 dark:text-ink-50">
            {thread.subject || '(no subject)'}
          </h3>
        </div>

        {/* Triage + routing chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {thread.classification && <Chip tone="accent">{labelize(thread.classification)}</Chip>}
          {thread.sentiment && (
            <Chip tone={SENTIMENT_TONE[thread.sentiment] || 'muted'}>{labelize(thread.sentiment)}</Chip>
          )}
          {thread.urgency && <Chip tone={URGENCY_TONE[thread.urgency] || 'muted'}>{labelize(thread.urgency)}</Chip>}
          {thread.status && <Chip tone={STATUS_TONE[thread.status] || 'muted'}>{labelize(thread.status)}</Chip>}
          {sla && (
            <Chip tone={sla.tone}>
              <Clock className="h-3 w-3" />
              {sla.text}
            </Chip>
          )}
        </div>

        {/* Message body */}
        <div className="rounded-xl border border-ink-200/50 dark:border-ink-800 bg-ink-50/50 dark:bg-ink-950/30 px-4 py-3 text-sm text-ink-700 dark:text-ink-100 leading-relaxed whitespace-pre-wrap break-words">
          {thread.body || 'No message body.'}
        </div>

        {/* Routing summary */}
        {(thread.specialist_role || thread.route_to) && (
          <p className="text-xs text-ink-500 dark:text-ink-300">
            Routed to{' '}
            <span className="font-medium text-ink-700 dark:text-ink-100">
              {labelize(thread.specialist_role || thread.route_to)}
            </span>
            {thread.escalation_level && thread.escalation_level > 0 ? ' · escalated' : ''}.
          </p>
        )}

        {/* AI suggested reply (advisory, beta) */}
        {draft && (
          <div className="rounded-xl border border-accent-200/50 dark:border-accent-900/40 bg-accent-50/40 dark:bg-accent-900/10 px-4 py-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-700 dark:text-ink-100">
              <Sparkles className="h-3.5 w-3.5 text-accent-500" />
              Suggested reply
              <span className="ml-1 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300 px-1.5 py-0.5 text-[10px] font-medium">
                beta
              </span>
            </div>
            {draft.subject_line && (
              <p className="text-xs text-ink-500 dark:text-ink-300">
                <span className="font-medium">Subject:</span> {draft.subject_line}
              </p>
            )}
            <p className="text-sm text-ink-700 dark:text-ink-100 leading-relaxed whitespace-pre-wrap break-words">
              {draft.body}
            </p>
            {draft.next_step && (
              <p className="text-xs text-ink-500 dark:text-ink-300">
                <span className="font-medium">Next step:</span> {draft.next_step}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={copyDraft}
                className="inline-flex items-center gap-1.5 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900 px-3 py-1.5 text-xs font-medium hover:shadow-card transition-shadow"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </button>
              <span className="text-[11px] text-ink-400">
                Sending from Maroa is coming soon — paste this into your channel.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="border-t border-ink-200/60 dark:border-ink-800 p-3 flex items-center gap-2">
        <button
          type="button"
          onClick={suggest}
          disabled={drafting}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:shadow-card transition-shadow disabled:opacity-60"
        >
          {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {draft ? 'Regenerate suggestion' : 'Suggest a reply'}
        </button>
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3" />
          Advisory · always review before sending
        </span>
      </div>
    </div>
  );
}
