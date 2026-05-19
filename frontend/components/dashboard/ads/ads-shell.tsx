'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  Megaphone,
  ArrowRight,
} from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { friendly, friendlyTime, decisionCategory } from '@/lib/translate';
import type {
  CreativeAsset,
  DecisionLogRow,
  WorkspaceFeed,
} from '@/lib/types/war-room';

/**
 * components/dashboard/ads/ads-shell.tsx
 * ---------------------------------------------------------------------------
 * Campaigns view — what Maroa's ad-optimizer is doing across Meta + Google.
 *
 * Sections:
 *   1. "How your ads are doing" — three friendly health pills
 *      (Working / Mixed / Needs attention) with one-line context.
 *   2. "Top performing ads" — top_creatives filtered to ad channels.
 *   3. "Recent moves" — decision-log rows from ad-optimizer (paused,
 *      scaled, optimized) in plain English.
 *
 * The pending-approval flow is handled by the inbox/dashboard — here we
 * focus on what's already running.
 * ---------------------------------------------------------------------------
 */

function isAdCreative(cr: CreativeAsset): boolean {
  return /(meta|google|tiktok|ads|ad-)/i.test(cr.channel);
}

function gatherAds(feed: WorkspaceFeed): {
  topAds: Array<CreativeAsset & { clientName: string }>;
  recentMoves: DecisionLogRow[];
} {
  const topAds: Array<CreativeAsset & { clientName: string }> = [];
  const recentMoves: DecisionLogRow[] = [];
  for (const c of feed.clients) {
    const clientName = c.client?.client_name || 'Your business';
    for (const cr of c.top_creatives) if (isAdCreative(cr)) topAds.push({ ...cr, clientName });
    for (const d of c.recent_decisions) {
      if (d.executed && decisionCategory(d) === 'ads') recentMoves.push(d);
    }
  }
  topAds.sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0));
  recentMoves.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
  return { topAds: topAds.slice(0, 6), recentMoves: recentMoves.slice(0, 8) };
}

function computeHealth(feed: WorkspaceFeed): {
  tone: 'good' | 'mixed' | 'attention';
  headline: string;
  context: string;
} {
  const summary = feed.summary;
  const decaying = summary.decaying_or_dead || 0;
  const live = summary.creatives_total || 0;
  if (live === 0) {
    return {
      tone: 'mixed',
      headline: 'No ads running yet.',
      context: 'Connect Meta or Google in Settings — I’ll start drafting once we’re wired up.',
    };
  }
  if (decaying === 0) {
    return {
      tone: 'good',
      headline: 'Your ads are pulling their weight.',
      context: 'I’m watching the numbers daily and will tell you the moment something slips.',
    };
  }
  if (decaying / Math.max(1, live) > 0.5) {
    return {
      tone: 'attention',
      headline: 'A few ads are fading.',
      context: 'I’ll surface refreshes in your inbox so the budget keeps working.',
    };
  }
  return {
    tone: 'mixed',
    headline: 'Most ads are on track.',
    context: `${decaying} are starting to fade — I’m drafting replacements.`,
  };
}

const TONE_STYLES = {
  good: {
    dot: 'bg-green-500',
    halo: 'bg-green-500/10',
    icon: TrendingUp,
    text: 'text-green-700 dark:text-green-300',
  },
  mixed: {
    dot: 'bg-amber-500',
    halo: 'bg-amber-500/10',
    icon: Minus,
    text: 'text-amber-700 dark:text-amber-300',
  },
  attention: {
    dot: 'bg-red-500',
    halo: 'bg-red-500/10',
    icon: TrendingDown,
    text: 'text-red-700 dark:text-red-300',
  },
} as const;

function channelLabel(channel: string): string {
  if (/meta|facebook|instagram/i.test(channel)) return 'Meta';
  if (/google/i.test(channel)) return 'Google';
  if (/tiktok/i.test(channel)) return 'TikTok';
  return channel.replace(/[-_]/g, ' ');
}

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export function AdsShell({ feed }: { feed: WorkspaceFeed }) {
  const { topAds, recentMoves } = useMemo(() => gatherAds(feed), [feed]);
  const health = useMemo(() => computeHealth(feed), [feed]);
  const tone = TONE_STYLES[health.tone];
  const HeadIcon = tone.icon;

  return (
    <div className="space-y-8">
      {/* Health hero */}
      <section
        aria-label="Ad health"
        className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-6 sm:px-8 py-7 flex items-start gap-5"
      >
        <span
          aria-hidden="true"
          className={cn('inline-flex h-12 w-12 items-center justify-center rounded-xl', tone.halo)}
        >
          <HeadIcon className={cn('h-6 w-6', tone.text)} strokeWidth={1.8} />
        </span>
        <div className="flex-1">
          <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Ad health</p>
          <h2 className="mt-1 text-xl sm:text-2xl text-ink-700 dark:text-ink-50 font-semibold tracking-tight">
            {health.headline}
          </h2>
          <p className="mt-2 text-ink-500 dark:text-ink-300 leading-relaxed">{health.context}</p>
        </div>
      </section>

      {/* Top ads */}
      <section className="space-y-4">
        <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Top performing ads</h2>
        {topAds.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No ad performance data yet."
            description="Once your ads have been running for a couple of days, the winners will surface here."
          />
        ) : (
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {topAds.map((cr) => (
              <li
                key={cr.id}
                className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-5"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-ink-300 font-medium">
                    {channelLabel(cr.channel)}
                  </span>
                  <span className="text-ink-300 dark:text-ink-600">·</span>
                  <span className="text-[10px] text-ink-500 dark:text-ink-300">{cr.clientName}</span>
                </div>
                {cr.cta_text && (
                  <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug font-medium line-clamp-2">
                    “{cr.cta_text}”
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <Metric label="Seen" value={formatBig(cr.impressions)} />
                  <Metric label="Clicks" value={formatBig(cr.clicks)} />
                  <Metric label="Leads" value={cr.conversions.toString()} />
                </dl>
                {cr.revenue_usd > 0 && (
                  <p className="mt-3 text-xs text-green-700 dark:text-green-300 font-medium">
                    Made you ${formatBig(Math.round(cr.revenue_usd))}.
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Recent moves */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Recent moves</h2>
          <Link
            href="/dashboard/pro"
            className="text-sm text-accent-500 hover:text-accent-600 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 rounded inline-flex items-center gap-1"
          >
            Full feed
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        {recentMoves.length === 0 ? (
          <p className="text-sm text-ink-500 dark:text-ink-300">No recent ad decisions yet.</p>
        ) : (
          <ol className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle divide-y divide-ink-200/60 dark:divide-ink-800 overflow-hidden">
            {recentMoves.map((d) => (
              <li key={d.id} className="px-5 sm:px-6 py-4 flex items-start gap-4">
                <span
                  aria-hidden="true"
                  className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100"
                >
                  <AlertCircle className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-ink-700 dark:text-ink-100 leading-snug">{friendly(d)}</p>
                  <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
                    {friendlyTime(d.created_at)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className="text-base text-ink-700 dark:text-ink-100 font-semibold">{value}</dd>
    </div>
  );
}
