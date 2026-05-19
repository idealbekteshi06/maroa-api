'use client';

import { useMemo, useState } from 'react';
import { Greeting } from './greeting';
import { HeadlineStatus } from './headline-status';
import { ApprovalCard } from './approval-card';
import { ActivityFeed } from './activity-feed';
import { CalmState } from './calm-state';
import type { WorkspaceFeed, DecisionLogRow } from '@/lib/types/war-room';

/**
 * components/dashboard/today/today-shell.tsx
 * ---------------------------------------------------------------------------
 * The calm dashboard. Single column, top to bottom:
 *
 *   1. Greeting (time-aware salutation)
 *   2. HeadlineStatus (one big outcome with friendly framing)
 *   3. Approval cards OR CalmState
 *   4. ActivityFeed (passive narration of what Maroa shipped)
 *
 * Receives the same WorkspaceFeed the War Room uses — we just reshape it.
 * That means the calm view shares one SSR fetch with the pro view; no
 * separate backend surface to maintain.
 *
 * `initialIsDemo` mirrors the WarRoomShell prop: when true, the fallback
 * data is the bundled mock and we soften the headline so the customer
 * isn't told a fake number.
 * ---------------------------------------------------------------------------
 */

export interface TodayShellProps {
  feed: WorkspaceFeed;
  firstName?: string | null;
  initialIsDemo?: boolean;
}

function pickPendingDecisions(feed: WorkspaceFeed): {
  decisions: DecisionLogRow[];
  byId: Map<string, DecisionLogRow>;
} {
  const byId = new Map<string, DecisionLogRow>();
  for (const client of feed.clients) {
    for (const d of client.recent_decisions) byId.set(d.id, d);
  }
  // "Pending" = required_approval and not yet executed, not refused.
  const decisions = Array.from(byId.values())
    .filter((d) => d.required_approval && !d.executed && !d.refused)
    .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
  return { decisions, byId };
}

function allRecentDecisions(feed: WorkspaceFeed): DecisionLogRow[] {
  const all: DecisionLogRow[] = [];
  for (const client of feed.clients) {
    for (const d of client.recent_decisions) all.push(d);
  }
  return all.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
}

function buildHeadline(feed: WorkspaceFeed, isDemo: boolean): {
  headline: string;
  context: string;
  detail?: string;
  tone: 'good' | 'neutral' | 'first-run';
} {
  if (isDemo) {
    return {
      headline: 'Connect your first account to see real numbers.',
      context:
        'Once you connect Instagram or Meta Ads, I’ll start working on your marketing and you’ll see the results here.',
      tone: 'first-run',
    };
  }
  const summary = feed.summary;
  const totalCreatives = summary.creatives_total || 0;
  const decaying = summary.decaying_or_dead || 0;
  const experiments = summary.experiments_running || 0;
  const pending = summary.pending_approvals || 0;

  if (totalCreatives === 0) {
    return {
      headline: 'I’m getting set up.',
      context: 'Give me a day or two — I’m studying your brand and drafting your first batch.',
      tone: 'first-run',
    };
  }

  if (pending > 0) {
    const word = pending === 1 ? 'thing' : 'things';
    return {
      headline: `Need your eyes on ${pending} ${word}.`,
      context: 'Quick yes or no — that’s all I need.',
      detail:
        experiments > 0 ? `${experiments} test${experiments === 1 ? '' : 's'} also running` : undefined,
      tone: 'neutral',
    };
  }

  const detailBits: string[] = [];
  if (experiments > 0) detailBits.push(`${experiments} test${experiments === 1 ? '' : 's'} running`);
  if (decaying > 0) detailBits.push(`watching ${decaying} fading creatives`);

  return {
    headline: `${totalCreatives} ${totalCreatives === 1 ? 'piece' : 'pieces'} of your marketing live.`,
    context: 'Everything I’m running is on track. I’ll let you know if that changes.',
    detail: detailBits.join(' · ') || undefined,
    tone: 'good',
  };
}

export function TodayShell({ feed, firstName, initialIsDemo = false }: TodayShellProps) {
  const { decisions: initialPending } = useMemo(() => pickPendingDecisions(feed), [feed]);
  const recent = useMemo(() => allRecentDecisions(feed), [feed]);
  const headline = useMemo(() => buildHeadline(feed, initialIsDemo), [feed, initialIsDemo]);

  // Local state for optimistic removal — when the user approves/rejects,
  // we drop the card from this list so the page stays calm without an
  // SSR roundtrip.
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  const visiblePending = initialPending.filter((d) => !resolvedIds.has(d.id));
  const workspaceId = feed.workspace.id;

  return (
    <div className="max-w-2xl mx-auto px-5 sm:px-0 py-8 sm:py-12 space-y-10">
      <header className="space-y-2">
        <Greeting firstName={firstName} />
        <p className="text-lg text-ink-500 dark:text-ink-300 leading-relaxed">
          Here’s where things stand.
        </p>
      </header>

      <HeadlineStatus
        headline={headline.headline}
        context={headline.context}
        detail={headline.detail}
        tone={headline.tone}
        detailsHref="/dashboard/pro"
      />

      <section aria-label="Pending approvals" className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
            {visiblePending.length > 0
              ? `Need your help on ${visiblePending.length} thing${visiblePending.length === 1 ? '' : 's'}`
              : 'You’re all caught up'}
          </h2>
        </div>

        {visiblePending.length === 0 ? (
          <CalmState />
        ) : (
          <div className="space-y-4">
            {visiblePending.map((d) => (
              <ApprovalCard
                key={d.id}
                workspaceId={workspaceId}
                decision={d}
                onResolved={(id) =>
                  setResolvedIds((prev) => {
                    const next = new Set(prev);
                    next.add(id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
      </section>

      <ActivityFeed decisions={recent} detailsHref="/dashboard/pro" />

      <footer className="pt-4 border-t border-ink-200/60 dark:border-ink-800">
        <p className="text-xs text-ink-500 dark:text-ink-300 text-center">
          Need the full operator view?{' '}
          <a
            href="/dashboard/pro"
            className="text-accent-500 hover:text-accent-600 font-medium focus-visible:outline-none focus-visible:underline"
          >
            Switch to Pro
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
