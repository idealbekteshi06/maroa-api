'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Activity, AlertCircle, Plus, FileBarChart } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { KpiStrip } from './kpi-strip';
import { ClientCard } from './client-card';
import { PriorityCard } from './priority-card';
import { fetchActiveWorkspaceFeed } from '@/lib/api/war-room';
import type { WorkspaceFeed } from '@/lib/types/war-room';
import { StaggerList } from '@/components/motion/stagger-list';
import { FadeIn } from '@/components/motion/fade-in';
import { MotionProvider } from '@/components/motion/motion-provider';
import { useDashboardBadgesSetter } from '@/components/dashboard/sidebar-badges-context';
import {
  CommandPaletteHandle,
  useCommandPaletteDataSetter,
} from '@/components/dashboard/command-palette';

/**
 * The interactive War Room. Three explicit bands with different visual
 * densities:
 *
 *   Band A — "Needs you"   (highest density, white surface, tight rhythm)
 *   Band B — "Working"     (medium density, KPIs + running operations ticker)
 *   Band C — "Resting"     (lowest density, muted surface, generous spacing)
 *
 * Demo-mode and empty-mode (?empty=1) both render through the same band
 * scaffolding so visual rhythm is identical regardless of data state.
 */
// `initialIsDemo` lets the server component tell us whether the
// fallbackFeed is real (SSR prefetched a feed) or mock (anonymous /
// API unreachable). When real, we skip the client refresh on first
// mount — saves a round-trip + the mock→real reflow.
// Audit 2026-05-19 F12.
export function WarRoomShell({
  fallbackFeed,
  initialIsDemo = true,
}: {
  fallbackFeed: WorkspaceFeed;
  initialIsDemo?: boolean;
}) {
  const [feed, setFeed] = useState<WorkspaceFeed>(fallbackFeed);
  const [isDemo, setIsDemo] = useState(initialIsDemo);
  const [loaded, setLoaded] = useState(!initialIsDemo);
  // ?empty=1 forces the three empty states without breaking the live data
  // path — kept as a single query gate so QA + designers can preview easily.
  const search = useSearchParams();
  const emptyMode = search?.get('empty') === '1';

  useEffect(() => {
    // Server already prefetched a real feed → skip the round-trip. Refresh
    // is opt-in via a manual reload or a future revalidate trigger.
    if (!initialIsDemo) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    fetchActiveWorkspaceFeed()
      .then((real) => {
        if (cancelled) return;
        if (real) {
          setFeed(real);
          setIsDemo(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialIsDemo]);

  const effectiveFeed: WorkspaceFeed = useMemo(() => {
    if (!emptyMode) return feed;
    return {
      ...feed,
      clients: [],
      pending_approvals: [],
      summary: {
        ...feed.summary,
        clients_total: 0,
        creatives_total: 0,
        decaying_or_dead: 0,
        experiments_running: 0,
        pending_approvals: 0,
      },
    };
  }, [feed, emptyMode]);

  const allDecisions = effectiveFeed.clients
    .flatMap((c) =>
      c.recent_decisions.map((d) => ({
        ...d,
        _clientName: c.client.client_name || c.business_id,
      })),
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const priorities = allDecisions
    .filter((d) => d.required_approval || d.refused || d.agent_name === 'competitor-watch')
    .slice(0, 5);

  const recentActivity = allDecisions.filter((d) => d.executed && !d.refused).slice(0, 6);
  const pendingApprovalCount = effectiveFeed.pending_approvals.length;
  const needsYouCount = priorities.length + pendingApprovalCount;

  // Publish sidebar badge counts so the chrome reflects the page's state.
  const publishBadges = useDashboardBadgesSetter();
  useEffect(() => {
    publishBadges({
      approvals: pendingApprovalCount,
      // Mock client-invite count + sync-failure flag until those endpoints land.
      clients: effectiveFeed.clients.length > 0 ? 1 : 0,
      settings: '!',
    });
  }, [publishBadges, pendingApprovalCount, effectiveFeed.clients.length]);

  // Publish data for the ⌘K palette: workspace id, client roster (for the
  // "jump to client" search), and the green-band decisions queued for
  // bulk-approve.
  const publishPaletteData = useCommandPaletteDataSetter();
  useEffect(() => {
    const greenBand = allDecisions
      .filter((d) => d.required_approval && !d.refused && d.auto_safe_band === 'green')
      .map((d) => ({ id: d.id, recommendation_text: d.recommendation_text }));
    publishPaletteData({
      workspaceId: effectiveFeed.workspace.id,
      clients: effectiveFeed.clients.map((c) => ({
        business_id: c.business_id,
        client_name: c.client.client_name || c.business_id,
      })),
      greenBandDecisions: greenBand,
    });
  }, [publishPaletteData, effectiveFeed.workspace.id, effectiveFeed.clients, allDecisions]);

  return (
    <MotionProvider>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-400">Workspace · {effectiveFeed.workspace.name}</p>
          <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight mt-1">
            War Room
          </h1>
          <p className="mt-2 text-ink-400 max-w-2xl">
            What Maroa noticed today, what it&apos;s recommending, what it already shipped, and what
            it needs you for.
          </p>
        </div>
        <CommandPaletteHandle />
      </header>

      {isDemo && loaded && !emptyMode && (
        <div
          role="status"
          className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200/60 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5 p-4"
        >
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Demo workspace — illustrative data
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300/80 mt-0.5">
              Create a workspace + connect your client accounts to replace this with live
              decisions, creatives, and approvals.
            </p>
          </div>
          <Link
            href="/settings"
            className="text-xs font-medium text-amber-900 dark:text-amber-200 hover:underline whitespace-nowrap"
          >
            Set up workspace →
          </Link>
        </div>
      )}

      {/* BAND A — Needs you ─────────────────────────────────────────────── */}
      <section aria-labelledby="band-a-heading" className="mt-2">
        <BandHeader
          id="band-a-heading"
          tone="urgent"
          eyebrow="Needs you"
          count={needsYouCount}
          countLabel={needsYouCount === 1 ? 'pending' : 'pending'}
          right={
            <Link
              href="/dashboard/approvals"
              className="text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400 inline-flex items-center gap-1"
            >
              All decisions
              <ArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        <div className="mt-4 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
          <div>
            {priorities.length === 0 ? (
              <EmptyPriorities />
            ) : (
              <StaggerList className="space-y-3" step={60}>
                {priorities.map((d) => (
                  <PriorityCard
                    key={d.id}
                    decision={d}
                    businessName={d._clientName}
                    workspaceId={effectiveFeed.workspace.id}
                  />
                ))}
              </StaggerList>
            )}
          </div>
          <ApprovalInboxList
            approvals={effectiveFeed.pending_approvals}
            clients={effectiveFeed.clients}
          />
        </div>
      </section>

      {/* BAND B — Working ───────────────────────────────────────────────── */}
      <section aria-labelledby="band-b-heading" className="mt-10">
        <BandHeader
          id="band-b-heading"
          tone="working"
          eyebrow="Working"
          count={effectiveFeed.summary.experiments_running + effectiveFeed.summary.creatives_total}
          countLabel="live operations"
        />
        <div className="mt-4 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
          <KpiStrip feed={effectiveFeed} emptyMode={emptyMode} />
          <RunningNowTicker activity={recentActivity} />
        </div>
      </section>

      {/* BAND C — Resting ──────────────────────────────────────────────── */}
      <section
        aria-labelledby="band-c-heading"
        className="mt-10 rounded-2xl bg-ink-50/40 dark:bg-ink-950/40 border border-ink-200/40 dark:border-ink-800/60 p-6"
      >
        <BandHeader
          id="band-c-heading"
          tone="resting"
          eyebrow="Resting"
          count={effectiveFeed.clients.length}
          countLabel="active clients"
          right={
            <Link
              href="/dashboard/clients"
              className="text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400 inline-flex items-center gap-1"
            >
              Manage
              <ArrowRight className="h-3 w-3" />
            </Link>
          }
        />
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {effectiveFeed.clients.length === 0 ? (
            <EmptyClients />
          ) : (
            effectiveFeed.clients.map((c, i) => (
              <FadeIn key={c.client.id} delay={i * 80}>
                <ClientCard client={c} />
              </FadeIn>
            ))
          )}
        </div>
        <div className="mt-6 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
          <PlanCard plan={effectiveFeed.workspace.plan_tier} />
          <Link
            href="/dashboard/reports"
            className="brand-edge inline-flex items-center justify-center gap-2 rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 px-4 py-3 text-sm font-medium text-ink-700 dark:text-ink-100 hover:border-ink-300 dark:hover:border-ink-600 transition-colors"
          >
            <FileBarChart className="h-4 w-4 text-ink-400" />
            View latest reports
            <ArrowRight className="h-3 w-3 text-ink-400" />
          </Link>
        </div>
      </section>
    </MotionProvider>
  );
}

// ─── Band-level helpers ────────────────────────────────────────────────────

function BandHeader({
  id,
  tone,
  eyebrow,
  count,
  countLabel,
  right,
}: {
  id?: string;
  tone: 'urgent' | 'working' | 'resting';
  eyebrow: string;
  count: number;
  countLabel: string;
  right?: React.ReactNode;
}) {
  const dotColor =
    tone === 'urgent'
      ? 'bg-amber-500'
      : tone === 'working'
      ? 'bg-accent-500'
      : 'bg-ink-300 dark:bg-ink-700';
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-2">
        <span className="pill">
          <span className={`pill-dot ${dotColor} ${tone === 'working' ? 'agent-pulse' : ''}`} aria-hidden="true" />
          <span className="font-medium">{eyebrow}</span>
          <span aria-hidden="true" className="text-ink-300 dark:text-ink-600">·</span>
          <span className="tabular-nums">{count}</span>
          <span className="text-ink-400 font-normal">{countLabel}</span>
        </span>
      </h2>
      {right}
    </div>
  );
}

function ApprovalInboxList({
  approvals,
  clients,
}: {
  approvals: WorkspaceFeed['pending_approvals'];
  clients: WorkspaceFeed['clients'];
}) {
  return (
    <aside className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4">
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3">
        Awaiting client review
      </p>
      {approvals.length === 0 ? (
        <p className="text-sm text-ink-400">Inbox zero.</p>
      ) : (
        <ul className="space-y-2">
          {approvals.map((a) => {
            const business = clients.find((c) => c.business_id === a.business_id);
            return (
              <li key={a.id}>
                <Link
                  href="/dashboard/approvals"
                  className="brand-edge block rounded-lg border border-amber-200/60 dark:border-amber-500/20 hover:border-amber-300 dark:hover:border-amber-500/40 p-2.5 transition-colors"
                >
                  <p className="text-[10px] uppercase tracking-wider text-ink-400">
                    {business?.client.client_name || a.business_id}
                  </p>
                  <p className="text-sm text-ink-700 dark:text-ink-100 truncate mt-0.5">
                    {a.client_email || 'Awaiting client review'}
                  </p>
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1">
                    Expires {new Date(a.expires_at).toLocaleDateString()}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/**
 * Right-rail "running now" ticker — 4 visible lines, rotating every 4s.
 * Reuses the cadence pattern from the hero ActivityFeed but here the items
 * are real recent executions.
 */
function RunningNowTicker({
  activity,
}: {
  activity: Array<{ id: string; agent_name: string; recommendation_text: string; _clientName: string }>;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [head, setHead] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion || activity.length < 5) return;
    const id = setInterval(() => {
      setHead((h) => (h + 1) % activity.length);
    }, 4000);
    return () => clearInterval(id);
  }, [activity.length, prefersReducedMotion]);

  const visible = activity.length === 0
    ? []
    : [0, 1, 2, 3].map((offset) => activity[(head + offset) % activity.length]).filter(Boolean) as typeof activity;

  return (
    <aside className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4">
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3 flex items-center gap-2">
        <Activity className="h-3 w-3 text-green-500" />
        Running now
      </p>
      {visible.length === 0 ? (
        <p className="text-sm text-ink-400">No auto-actions yet.</p>
      ) : (
        <ol className="relative border-l-2 border-ink-200 dark:border-ink-700 pl-4 space-y-3">
          {visible.map((d, i) => (
            <li key={`${head}-${d.id}-${i}`} className="relative">
              <span
                className="absolute -left-[22px] top-1.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-4 ring-white dark:ring-ink-900"
                aria-hidden="true"
              />
              <p className="text-[10px] uppercase tracking-wider text-ink-400">
                {d.agent_name.replace(/-/g, ' ')} · {d._clientName}
              </p>
              <p className="text-xs text-ink-700 dark:text-ink-100 leading-snug mt-0.5 line-clamp-2">
                {d.recommendation_text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function PlanCard({ plan }: { plan: string }) {
  const blurb =
    plan === 'freelancer'
      ? '20 client cap · $199/mo'
      : plan === 'agency'
      ? 'Agency · $99/mo'
      : plan === 'enterprise'
      ? 'Custom'
      : 'See /pricing';
  return (
    <div className="rounded-xl bg-ink-700 dark:bg-ink-800 text-white p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-ink-100/70">Plan</p>
        <p className="text-base font-semibold capitalize">{plan}</p>
        <p className="text-xs text-ink-100/80">{blurb}</p>
      </div>
      <Link
        href="/settings"
        className="text-xs font-medium text-white hover:text-ink-100 inline-flex items-center gap-1 whitespace-nowrap"
      >
        Manage
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

// ─── Empty states ──────────────────────────────────────────────────────────

function EmptyPriorities() {
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-10 text-center">
      <div className="mx-auto mb-5 w-24 h-24 flex items-center justify-center" aria-hidden="true">
        <EmptyInboxIllustration />
      </div>
      <p className="text-base font-semibold text-ink-700 dark:text-ink-100">All clear</p>
      <p className="mt-1 text-sm text-ink-400 max-w-sm mx-auto">
        No decisions need you right now. Maroa will surface anything that does.
      </p>
      <Link
        href="/dashboard/reports"
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400"
      >
        View 24h history
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

/**
 * Empty-inbox micro-illustration — three stacked "card" rectangles fading
 * up the pile, with the topmost rendered as a check inside a circular halo.
 * Pure SVG, dark-mode safe via currentColor.
 */
function EmptyInboxIllustration() {
  return (
    <svg
      width="96"
      height="96"
      viewBox="0 0 96 96"
      fill="none"
      className="text-ink-300 dark:text-ink-700"
      role="presentation"
    >
      {/* Bottom card — most faded */}
      <rect x="14" y="58" width="68" height="10" rx="3" fill="currentColor" opacity="0.35" />
      {/* Middle card */}
      <rect x="10" y="46" width="76" height="10" rx="3" fill="currentColor" opacity="0.55" />
      {/* Top card — most defined */}
      <rect
        x="6"
        y="32"
        width="84"
        height="12"
        rx="3.5"
        fill="currentColor"
        opacity="0.85"
      />
      {/* Halo + check above the stack */}
      <circle cx="48" cy="18" r="14" fill="none" stroke="#34C759" strokeWidth="1.5" opacity="0.35" />
      <circle cx="48" cy="18" r="9.5" fill="#34C759" opacity="0.12" />
      <path
        d="M43 18.5 L46.4 22 L53.5 14.5"
        stroke="#34C759"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function EmptyClients() {
  return (
    <Link
      href="/onboarding"
      className="md:col-span-2 flex flex-col items-center justify-center text-center rounded-xl border-2 border-dashed border-ink-200 dark:border-ink-700 p-10 hover:border-accent-400 dark:hover:border-accent-500/40 hover:bg-accent-50/30 dark:hover:bg-accent-500/5 transition-colors"
    >
      <span className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full border border-ink-200 dark:border-ink-700">
        <Plus className="h-4 w-4 text-ink-400" />
      </span>
      <span className="text-base font-semibold text-ink-700 dark:text-ink-100">
        Add your first client
      </span>
      <span className="mt-1 text-sm text-ink-400">
        Connect a business and Maroa will start surfacing decisions for it.
      </span>
    </Link>
  );
}

