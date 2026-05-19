import { TrendingUp, TrendingDown, Minus, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { KpiHistory, KpiHistoryKey, WorkspaceFeed } from '@/lib/types/war-room';

/**
 * components/dashboard/reports/reports-shell.tsx
 * ---------------------------------------------------------------------------
 * Reports page — the weekly review surface.
 *
 * Pulls from feed.kpi_history (added by routes/war-room.js — see
 * lib/warRoomKpiHistory.js). Each KPI gets a card with:
 *   - The current value
 *   - A 7-day sparkline (CSS-only — no chart library on this page)
 *   - Week-over-week delta with friendly tone
 *   - Plain-English context line
 *
 * If kpi_history is missing (legacy backend / degraded response), we
 * render an empty hint rather than blanks.
 * ---------------------------------------------------------------------------
 */

const KPI_LABELS: Record<KpiHistoryKey, { title: string; context: (n: number) => string }> = {
  active_clients: {
    title: 'Active clients',
    context: (n) => (n === 1 ? '1 active client' : `${n} active clients`),
  },
  creatives_total: {
    title: 'Pieces live',
    context: (n) => (n === 1 ? '1 piece running' : `${n} pieces running`),
  },
  decaying_or_dead: {
    title: 'Fading creatives',
    context: (n) =>
      n === 0
        ? 'Nothing is fading — everything’s pulling weight.'
        : n === 1
          ? '1 piece is fading. I’ll surface a refresh soon.'
          : `${n} pieces are fading. I’m drafting replacements.`,
  },
  experiments_running: {
    title: 'A/B tests running',
    context: (n) => (n === 0 ? 'No tests this week.' : `${n} running this week.`),
  },
  pending_approvals: {
    title: 'Awaiting your approval',
    context: (n) => (n === 0 ? 'Inbox clear.' : `${n} waiting on your yes/no.`),
  },
  refusals_7d: {
    title: 'You rejected',
    context: (n) => (n === 0 ? 'Nothing rejected this week.' : `${n} ${n === 1 ? 'thing' : 'things'} this week.`),
  },
};

function Sparkline({ values, tone }: { values: number[]; tone: 'up' | 'down' | 'flat' }) {
  if (!values || values.length === 0) {
    return <div className="h-6 w-full bg-ink-100 dark:bg-ink-800 rounded-sm" aria-hidden="true" />;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const color =
    tone === 'up'
      ? 'fill-green-500/80'
      : tone === 'down'
        ? 'fill-red-500/80'
        : 'fill-ink-400/60';
  const stroke =
    tone === 'up'
      ? 'stroke-green-500'
      : tone === 'down'
        ? 'stroke-red-500'
        : 'stroke-ink-400';

  const W = 120;
  const H = 32;
  const stepX = W / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M${points.join(' L')}`;
  const fillPath = `${linePath} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-hidden="true"
      className="overflow-visible"
    >
      <path d={fillPath} className={color} opacity={0.25} />
      <path d={linePath} fill="none" className={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function trendIcon(trend: 'up' | 'down' | 'flat', delta: number) {
  // Some KPIs are good when they go up (creatives_total, experiments) and
  // some are good when they go down (decaying_or_dead, pending_approvals,
  // refusals_7d). The card knows its own polarity below.
  if (trend === 'up') return TrendingUp;
  if (trend === 'down') return TrendingDown;
  return Minus;
}

const HIGHER_IS_BETTER: Record<KpiHistoryKey, boolean> = {
  active_clients: true,
  creatives_total: true,
  experiments_running: true,
  decaying_or_dead: false,
  pending_approvals: false,
  refusals_7d: false,
};

export function ReportsShell({ feed }: { feed: WorkspaceFeed }) {
  const history = feed.kpi_history;
  if (!history) {
    return (
      <section className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-6 py-10 text-center">
        <p className="text-ink-700 dark:text-ink-100 font-medium text-lg">
          Your first weekly snapshot is on its way.
        </p>
        <p className="mt-2 text-ink-500 dark:text-ink-300">
          Once Maroa has a week of activity under its belt, the trend cards here will fill in.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(Object.keys(KPI_LABELS) as KpiHistoryKey[]).map((k) => {
          const values = history[k] || [];
          const delta = history.delta_pct?.[k] ?? 0;
          const trend = history.trend?.[k] ?? 'flat';
          const current = values[values.length - 1] ?? 0;
          const goodPolarity = HIGHER_IS_BETTER[k];
          const isGood =
            (goodPolarity && trend === 'up') || (!goodPolarity && trend === 'down');
          const isBad =
            (goodPolarity && trend === 'down') || (!goodPolarity && trend === 'up');
          const TrendIcon = trendIcon(trend, delta);
          const label = KPI_LABELS[k];
          return (
            <article
              key={k}
              className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-5"
            >
              <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
                {label.title}
              </p>
              <div className="mt-2 flex items-end justify-between gap-3">
                <p className="text-3xl text-ink-700 dark:text-ink-50 font-semibold tracking-tight">
                  {current}
                </p>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                    isGood
                      ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300'
                      : isBad
                        ? 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-200',
                  )}
                >
                  <TrendIcon className="h-3 w-3" aria-hidden="true" />
                  {Math.abs(Math.round(delta))}%
                </span>
              </div>
              <div className="mt-3">
                <Sparkline values={values} tone={trend} />
              </div>
              <p className="mt-3 text-xs text-ink-500 dark:text-ink-300 leading-relaxed">
                {label.context(current)}
              </p>
            </article>
          );
        })}
      </section>

      <section className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 px-6 py-6 flex items-start gap-4">
        <span
          aria-hidden="true"
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-50 dark:bg-accent-900/30 text-accent-500 shrink-0"
        >
          <ArrowRight className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Next week</p>
          <p className="mt-1 text-lg text-ink-700 dark:text-ink-50 font-medium">
            I’ll send the full scorecard to your inbox every Sunday at 5 p.m.
          </p>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            Want it sooner? Settings → AI preferences lets you change the cadence.
          </p>
        </div>
      </section>
    </div>
  );
}
