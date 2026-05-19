import Link from 'next/link';
import { ArrowLeft, Sparkles, AlertCircle, Megaphone, FlaskConical } from 'lucide-react';
import { ActivityFeed } from '@/components/dashboard/today/activity-feed';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { friendlyTime } from '@/lib/translate';
import type { ClientFeed } from '@/lib/types/war-room';

/**
 * components/dashboard/clients/client-detail.tsx
 * ---------------------------------------------------------------------------
 * Per-client drill-in. Three sections:
 *
 *   1. Header — client name, retainer, status pill
 *   2. KPI strip — total live, decaying, experiments running
 *   3. Top creatives + decaying creatives side-by-side
 *   4. Recent activity (Maroa's decision log for this business)
 * ---------------------------------------------------------------------------
 */

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function channelLabel(channel: string): string {
  if (/meta|facebook|instagram/i.test(channel)) return 'Meta';
  if (/google/i.test(channel)) return 'Google';
  if (/tiktok/i.test(channel)) return 'TikTok';
  if (/linkedin/i.test(channel)) return 'LinkedIn';
  return channel.replace(/[-_]/g, ' ');
}

export function ClientDetail({ feed }: { feed: ClientFeed }) {
  const decaying = (feed.decay_buckets?.decaying || 0) + (feed.decay_buckets?.dead || 0);
  return (
    <div className="space-y-8">
      <Link
        href="/dashboard/clients"
        className="inline-flex items-center gap-1.5 text-sm text-ink-500 dark:text-ink-300 hover:text-ink-700 dark:hover:text-ink-100"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All clients
      </Link>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Live" value={feed.creatives_total} />
        <Kpi label="Working" value={feed.decay_buckets?.fresh || 0} tone="good" />
        <Kpi label="Maturing" value={feed.decay_buckets?.maturing || 0} tone="muted" />
        <Kpi label="Fading" value={decaying} tone={decaying > 0 ? 'attention' : 'muted'} />
      </section>

      <section className="space-y-4">
        <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Top performers</h2>
        {feed.top_creatives.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No performance data yet."
            description="Once posts and ads have been live for a couple of days, the winners will show up here."
          />
        ) : (
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {feed.top_creatives.slice(0, 6).map((cr) => (
              <li
                key={cr.id}
                className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-5"
              >
                <p className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-ink-300 font-medium">
                  {channelLabel(cr.channel)}
                </p>
                {cr.cta_text && (
                  <p className="mt-2 text-sm text-ink-700 dark:text-ink-100 leading-snug font-medium line-clamp-2">
                    “{cr.cta_text}”
                  </p>
                )}
                <p className="mt-2 text-xs text-ink-500 dark:text-ink-300">
                  Seen {formatBig(cr.impressions)} · {cr.conversions}{' '}
                  {cr.conversions === 1 ? 'lead' : 'leads'}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {feed.decaying_creatives.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Getting tired</h2>
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {feed.decaying_creatives.slice(0, 6).map((cr) => (
              <li
                key={cr.id}
                className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-5"
              >
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-ink-300 font-medium">
                    {channelLabel(cr.channel)}
                  </p>
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    <AlertCircle className="h-3 w-3" aria-hidden="true" /> Fading
                  </span>
                </div>
                {cr.cta_text && (
                  <p className="mt-2 text-sm text-ink-700 dark:text-ink-100 leading-snug line-clamp-2">
                    “{cr.cta_text}”
                  </p>
                )}
                <p className="mt-2 text-xs text-ink-500 dark:text-ink-300">
                  Live {friendlyTime(cr.created_at)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {feed.experiments_running.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">A/B tests running</h2>
          <ol className="space-y-2">
            {feed.experiments_running.map((e) => (
              <li
                key={e.id}
                className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-5 py-4 flex items-start gap-3"
              >
                <FlaskConical
                  className="h-5 w-5 text-accent-500 mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-ink-700 dark:text-ink-50 font-medium">{e.name}</p>
                  {e.hypothesis && (
                    <p className="text-sm text-ink-500 dark:text-ink-300 mt-0.5">{e.hypothesis}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <ActivityFeed decisions={feed.recent_decisions} detailsHref="/dashboard/pro" />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'good' | 'muted' | 'attention';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-700 dark:text-green-300'
      : tone === 'attention'
        ? 'text-amber-700 dark:text-amber-300'
        : tone === 'muted'
          ? 'text-ink-500 dark:text-ink-300'
          : 'text-ink-700 dark:text-ink-50';
  return (
    <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-5 py-4">
      <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tracking-tight', toneClass)}>{value}</p>
    </div>
  );
}
