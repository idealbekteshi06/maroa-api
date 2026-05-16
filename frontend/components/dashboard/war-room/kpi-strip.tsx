'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Users2, FileImage, FlaskConical, AlertOctagon, ListChecks } from 'lucide-react';
import type { WorkspaceFeed } from '@/lib/types/war-room';

type Kpi = {
  label: string;
  value: number;
  trend?: string;
  icon: typeof Users2;
  tone?: 'default' | 'warn' | 'success';
};

function buildKpis(feed: WorkspaceFeed): Kpi[] {
  const { summary } = feed;
  return [
    {
      label: 'Active clients',
      value: summary.clients_total,
      trend: 'across workspace',
      icon: Users2,
    },
    {
      label: 'Creatives live',
      value: summary.creatives_total,
      trend: `${summary.decaying_or_dead} need refresh`,
      icon: FileImage,
      tone: summary.decaying_or_dead > summary.creatives_total * 0.3 ? 'warn' : 'default',
    },
    {
      label: 'Experiments running',
      value: summary.experiments_running,
      trend: summary.experiments_running > 0 ? 'collecting data' : 'idle',
      icon: FlaskConical,
    },
    {
      label: 'Awaiting approval',
      value: summary.pending_approvals,
      trend: summary.pending_approvals > 0 ? 'action required' : 'all clear',
      icon: ListChecks,
      tone: summary.pending_approvals > 0 ? 'warn' : 'success',
    },
    {
      label: 'Refusals (7d)',
      value: feed.clients
        .flatMap((c) => c.recent_decisions)
        .filter((d) => d.refused && new Date(d.created_at) > new Date(Date.now() - 7 * 86400000)).length,
      trend: 'compliance + ethics',
      icon: AlertOctagon,
    },
  ];
}

const TONE = {
  default: 'text-ink-700 dark:text-ink-100',
  warn: 'text-amber-700 dark:text-amber-400',
  success: 'text-green-700 dark:text-green-400',
};

export function KpiStrip({ feed }: { feed: WorkspaceFeed }) {
  const kpis = buildKpis(feed);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
      {kpis.map((kpi, i) => (
        <div
          key={kpi.label}
          className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-wider text-ink-400">{kpi.label}</p>
            <kpi.icon className="h-4 w-4 text-ink-400" />
          </div>
          <p className={`text-2xl font-semibold tracking-tight tabular-nums ${TONE[kpi.tone || 'default']}`}>
            <CountUp target={kpi.value} delayMs={i * 80} />
          </p>
          {kpi.trend && <p className="text-xs text-ink-400 mt-0.5">{kpi.trend}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * Counts from 0 to `target` over 450ms using an ease-out-cubic curve.
 * Runs once on mount. Reduced-motion: target value rendered immediately.
 */
function CountUp({ target, delayMs }: { target: number; delayMs: number }) {
  const prefersReducedMotion = useReducedMotion();
  const [value, setValue] = useState(prefersReducedMotion ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion) {
      setValue(target);
      return;
    }
    let raf = 0;
    let start = 0;
    const duration = 450;
    function tick(ts: number) {
      if (!start) start = ts;
      const elapsed = ts - start;
      if (elapsed < delayMs) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, (elapsed - delayMs) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delayMs, prefersReducedMotion]);

  return <>{value}</>;
}
