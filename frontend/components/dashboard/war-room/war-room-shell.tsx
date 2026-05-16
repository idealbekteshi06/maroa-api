'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Inbox, Activity, Sparkles, AlertCircle } from 'lucide-react';
import { KpiStrip } from './kpi-strip';
import { ClientCard } from './client-card';
import { PriorityCard } from './priority-card';
import { fetchActiveWorkspaceFeed } from '@/lib/api/war-room';
import type { WorkspaceFeed } from '@/lib/types/war-room';

/**
 * The interactive War Room. Receives `fallbackFeed` (the bundled mock) so
 * the first paint is immediate. On mount, attempts a real fetch against
 * /api/war-room/:workspaceId via the authenticated API client. Outcomes:
 *
 *   - Real data: swap fallback → real, hide the demo banner.
 *   - No session / no workspace / 5xx: keep fallback, show demo banner
 *     so the user always knows whether they're looking at illustrative
 *     numbers or their own.
 *
 * Designed so a freelancer signing in for the first time sees something
 * meaningful before any data has been seeded.
 */
export function WarRoomShell({ fallbackFeed }: { fallbackFeed: WorkspaceFeed }) {
  const [feed, setFeed] = useState<WorkspaceFeed>(fallbackFeed);
  const [isDemo, setIsDemo] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
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
  }, []);

  const allDecisions = feed.clients
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

  return (
    <>
      <header className="mb-8">
        <p className="text-sm text-ink-400">Workspace · {feed.workspace.name}</p>
        <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight mt-1">
          War Room
        </h1>
        <p className="mt-2 text-ink-400 max-w-2xl">
          What Maroa noticed today, what it&apos;s recommending, what it already shipped, and what
          it needs you for.
        </p>
      </header>

      {isDemo && loaded && (
        <div
          role="status"
          className="mb-8 flex items-start gap-3 rounded-2xl border border-amber-200/60 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/5 p-4"
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
            href="/settings/workspace"
            className="text-xs font-medium text-amber-900 dark:text-amber-200 hover:underline whitespace-nowrap"
          >
            Set up workspace →
          </Link>
        </div>
      )}

      <section className="mb-10">
        <KpiStrip feed={feed} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-10">
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent-500" />
                Priorities
                <span className="text-xs font-normal text-ink-400">— what to act on first</span>
              </h2>
              <Link
                href="/dashboard/decisions"
                className="text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400 inline-flex items-center gap-1"
              >
                All decisions
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {priorities.length === 0 ? (
              <div className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-12 text-center">
                <p className="text-ink-400">All clear. Nothing needs your attention right now.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {priorities.map((d) => (
                  <PriorityCard
                    key={d.id}
                    decision={d}
                    businessName={d._clientName}
                    workspaceId={feed.workspace.id}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100">
                Clients
                <span className="text-xs font-normal text-ink-400 ml-2">
                  — {feed.clients.length} active
                </span>
              </h2>
              <Link
                href="/dashboard/clients"
                className="text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400 inline-flex items-center gap-1"
              >
                Manage clients
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {feed.clients.map((c) => (
                <ClientCard key={c.client.id} client={c} />
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-8">
          <section>
            <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 flex items-center gap-2 mb-4">
              <Inbox className="h-4 w-4 text-amber-500" />
              Approval inbox
              <span className="text-xs font-normal text-ink-400">
                — {feed.pending_approvals.length}
              </span>
            </h2>
            {feed.pending_approvals.length === 0 ? (
              <div className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-6 text-center">
                <p className="text-sm text-ink-400">Inbox zero.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {feed.pending_approvals.map((a) => {
                  const business = feed.clients.find((c) => c.business_id === a.business_id);
                  return (
                    <li key={a.id}>
                      <Link
                        href={`/dashboard/approvals/${a.id}`}
                        className="block rounded-xl bg-white dark:bg-ink-900 border border-amber-200/60 dark:border-amber-500/20 hover:border-amber-300 dark:hover:border-amber-500/40 p-3 transition-colors"
                      >
                        <p className="text-xs text-ink-400 mb-1">
                          {business?.client.client_name || a.business_id}
                        </p>
                        <p className="text-sm text-ink-700 dark:text-ink-100 truncate">
                          {a.client_email || 'Awaiting client review'}
                        </p>
                        <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                          Expires {new Date(a.expires_at).toLocaleDateString()}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 flex items-center gap-2 mb-4">
              <Activity className="h-4 w-4 text-green-500" />
              Recent activity
            </h2>
            {recentActivity.length === 0 ? (
              <div className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-6 text-center">
                <p className="text-sm text-ink-400">No auto-actions yet.</p>
              </div>
            ) : (
              <ol className="relative border-l-2 border-ink-200 dark:border-ink-700 pl-5 space-y-4">
                {recentActivity.map((d) => (
                  <li key={d.id} className="relative">
                    <span
                      className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-green-500 ring-4 ring-white dark:ring-ink-950"
                      aria-hidden="true"
                    />
                    <p className="text-xs text-ink-400 mb-0.5">
                      {d.agent_name.replace(/-/g, ' ')} · {d._clientName}
                    </p>
                    <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug">
                      {d.recommendation_text}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="rounded-2xl bg-ink-700 dark:bg-ink-800 text-white p-6">
            <p className="text-xs uppercase tracking-wider text-ink-100/70 mb-2">Plan</p>
            <p className="text-lg font-semibold capitalize">{feed.workspace.plan_tier}</p>
            <p className="text-sm text-ink-100/80 mt-1">
              {feed.workspace.plan_tier === 'freelancer'
                ? '20 client cap · $199/mo'
                : feed.workspace.plan_tier === 'agency'
                ? '50 client cap · $499/mo'
                : feed.workspace.plan_tier === 'enterprise'
                ? 'Custom'
                : 'See /pricing'}
            </p>
            <Link
              href="/settings"
              className="mt-4 inline-flex items-center text-sm font-medium text-white hover:text-ink-100"
            >
              Manage plan
              <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
