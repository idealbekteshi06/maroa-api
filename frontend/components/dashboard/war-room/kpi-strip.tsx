'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  Users2,
  FileImage,
  FlaskConical,
  AlertOctagon,
  ListChecks,
  ChevronUp,
  ChevronDown,
  Minus,
} from 'lucide-react';
import type { WorkspaceFeed } from '@/lib/types/war-room';
import { STATE_DOTS } from '@/lib/design-tokens';

type Trend = 'up' | 'down' | 'flat';

type Kpi = {
  label: string;
  value: number;
  trend?: string;
  icon: typeof Users2;
  tone?: 'default' | 'warn' | 'success';
  /** 7-day mock history. The last entry is `value`; earlier entries jitter
      around it so the line reads as a real-ish series. Wire to the API
      next pass. */
  history: number[];
  trendDir: Trend;
  deltaPct: number;
};

function jitterHistory(target: number, seed: number, dir: Trend): number[] {
  // Stable pseudo-random so the line doesn't reshuffle on every render.
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const out: number[] = [];
  // Build a smooth-ish progression toward `target` based on direction.
  const baseStart =
    dir === 'up' ? Math.max(0, target * 0.78) : dir === 'down' ? target * 1.22 : target;
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const base = baseStart + (target - baseStart) * t;
    const jitter = (rand() - 0.5) * (target > 0 ? target * 0.12 : 1);
    out.push(Math.max(0, Math.round(base + jitter)));
  }
  // Force the final point to equal the canonical value.
  out[6] = target;
  return out;
}

function buildKpis(feed: WorkspaceFeed): Kpi[] {
  const { summary } = feed;
  const refusals7d = feed.clients
    .flatMap((c) => c.recent_decisions)
    .filter((d) => d.refused && new Date(d.created_at) > new Date(Date.now() - 7 * 86400000)).length;

  const rows: Array<Omit<Kpi, 'history'>> = [
    {
      label: 'Active clients',
      value: summary.clients_total,
      trend: '+1 vs last week',
      icon: Users2,
      trendDir: 'up',
      deltaPct: 12,
    },
    {
      label: 'Creatives live',
      value: summary.creatives_total,
      trend: `${summary.decaying_or_dead} need refresh`,
      icon: FileImage,
      tone: summary.decaying_or_dead > summary.creatives_total * 0.3 ? 'warn' : 'default',
      trendDir: 'up',
      deltaPct: 8,
    },
    {
      label: 'Experiments running',
      value: summary.experiments_running,
      trend: summary.experiments_running > 0 ? 'collecting data' : 'idle',
      icon: FlaskConical,
      trendDir: 'flat',
      deltaPct: 0,
    },
    {
      label: 'Awaiting approval',
      value: summary.pending_approvals,
      trend: summary.pending_approvals > 0 ? 'action required' : 'all clear',
      icon: ListChecks,
      tone: summary.pending_approvals > 0 ? 'warn' : 'success',
      trendDir: summary.pending_approvals > 0 ? 'up' : 'down',
      deltaPct: summary.pending_approvals > 0 ? 25 : -33,
    },
    {
      label: 'Refusals (7d)',
      value: refusals7d,
      trend: 'compliance + ethics',
      icon: AlertOctagon,
      trendDir: refusals7d > 0 ? 'up' : 'flat',
      deltaPct: refusals7d > 0 ? 100 : 0,
    },
  ];

  return rows.map((r, i) => ({ ...r, history: jitterHistory(r.value, i + 1, r.trendDir) }));
}

const TONE = {
  default: 'text-ink-700 dark:text-ink-100',
  warn: 'text-amber-700 dark:text-amber-400',
  success: 'text-green-700 dark:text-green-400',
};

export function KpiStrip({ feed, emptyMode = false }: { feed: WorkspaceFeed; emptyMode?: boolean }) {
  const kpis = buildKpis(feed);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {kpis.map((kpi, i) => (
        <div
          key={kpi.label}
          className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-wider text-ink-400">{kpi.label}</p>
            <kpi.icon className="h-4 w-4 text-ink-400" />
          </div>
          <p
            className={`text-2xl font-semibold tracking-tight tabular-nums ${
              emptyMode ? 'text-ink-400' : TONE[kpi.tone || 'default']
            }`}
          >
            <CountUp target={kpi.value} delayMs={i * 80} emptyMode={emptyMode} />
          </p>
          <div className="mt-2">
            <Sparkline points={kpi.history} trend={kpi.trendDir} emptyMode={emptyMode} />
          </div>
          <DeltaPill delta={kpi.deltaPct} trend={kpi.trendDir} emptyMode={emptyMode} />
        </div>
      ))}
    </div>
  );
}

/**
 * Inline SVG sparkline. Catmull-Rom smoothed into cubic Bezier so the line
 * reads as a curve, not a polyline. Hover (desktop only) reveals point
 * markers + a vertical guideline at the last point. No JS hover state.
 * Reduced-motion + emptyMode short-circuit any drawing animation; line is
 * rendered statically.
 */
function Sparkline({
  points,
  trend,
  emptyMode,
}: {
  points: number[];
  trend: Trend;
  emptyMode: boolean;
}) {
  const w = 100;
  const h = 28;
  const padX = 2;
  const padY = 3;

  if (emptyMode) {
    return (
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-7"
        role="img"
        aria-label="No data"
        preserveAspectRatio="none"
      >
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <circle
            key={i}
            cx={padX + (i * (w - padX * 2)) / 6}
            cy={h / 2}
            r={1.2}
            fill="currentColor"
            className="text-ink-300 dark:text-ink-700"
          />
        ))}
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(1, max - min);
  const xy = points.map((v, i) => ({
    x: padX + (i * (w - padX * 2)) / (points.length - 1),
    y: padY + (h - padY * 2) * (1 - (v - min) / range),
  }));

  // Catmull-Rom → Bezier (tension = 0.5)
  const d = xy
    .map((p, i, arr) => {
      if (i === 0) return `M ${p.x},${p.y}`;
      const p0 = arr[i - 2] ?? arr[i - 1]!;
      const p1 = arr[i - 1]!;
      const p2 = p;
      const p3 = arr[i + 1] ?? p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      return `C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
    })
    .join(' ');

  const stroke =
    trend === 'up' ? STATE_DOTS.green : trend === 'down' ? STATE_DOTS.red : STATE_DOTS.gray;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-7 sparkline-svg"
      role="img"
      aria-label={`7-day trend: ${trend}`}
      preserveAspectRatio="none"
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {/* Hover affordance — points + last-x guideline. Hidden by default,
          revealed by sparkline-svg:hover via CSS (see globals.css). */}
      <g className="sparkline-hover">
        {xy.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.4} fill={stroke} />
        ))}
        <line
          x1={xy[xy.length - 1]!.x}
          y1={padY}
          x2={xy[xy.length - 1]!.x}
          y2={h - padY}
          stroke={stroke}
          strokeWidth={0.6}
          strokeDasharray="1.5 1.5"
        />
      </g>
    </svg>
  );
}

function DeltaPill({
  delta,
  trend,
  emptyMode,
}: {
  delta: number;
  trend: Trend;
  emptyMode: boolean;
}) {
  if (emptyMode) {
    return (
      <p className="mt-1 text-[10px] text-ink-400 inline-flex items-center gap-1">
        <Minus className="h-2.5 w-2.5" />
        — vs last week
      </p>
    );
  }
  const Arrow = trend === 'up' ? ChevronUp : trend === 'down' ? ChevronDown : Minus;
  const color =
    trend === 'up'
      ? 'text-green-700 dark:text-green-400'
      : trend === 'down'
      ? 'text-red-700 dark:text-red-400'
      : 'text-ink-400';
  const sign = delta > 0 ? '+' : '';
  return (
    <p className={`mt-1 text-[10px] inline-flex items-center gap-1 ${color}`}>
      <Arrow className="h-2.5 w-2.5" strokeWidth={2.5} />
      <span className="tabular-nums font-medium">
        {sign}
        {delta}%
      </span>
      <span className="text-ink-400 font-normal">vs last week</span>
    </p>
  );
}

/**
 * Counts from 0 to `target` over 450ms using an ease-out-cubic curve.
 * Runs once on mount. Reduced-motion or empty-mode: value rendered as-is.
 */
function CountUp({
  target,
  delayMs,
  emptyMode,
}: {
  target: number;
  delayMs: number;
  emptyMode: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [value, setValue] = useState(prefersReducedMotion || emptyMode ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion || emptyMode) {
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
  }, [target, delayMs, prefersReducedMotion, emptyMode]);

  return <>{value}</>;
}
