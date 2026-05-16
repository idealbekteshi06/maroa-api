'use client';

import {
  Sparkles,
  AlertCircle,
  ShieldCheck,
  TrendingUp,
  Inbox,
  Check,
  Eye,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import { DURATION, EASING_BEZIER, STATE_DOTS } from '@/lib/design-tokens';

/**
 * HeroPreview — the marketing-home hero visual.
 *
 * A scripted 10-second loop of Maroa working: ad-optimizer decision → user
 * approves → compliance refusal → competitor-watch suggestion → restart.
 * The chrome stays put; only the content shifts. Pauses when scrolled off
 * screen or when the tab is hidden. Respects prefers-reduced-motion (shows
 * only the first card, no loop).
 *
 * The right rail "Just shipped" feed cycles independently on a 4-second
 * cadence. The KPI strip counts up from 0 once on mount.
 */

type CardId = 'optimizer' | 'refusal' | 'competitor';

// Loop schedule (ms from loop start). Beats 1/4/6 reveal cards; 3/5/7
// dismiss the prior card; 8 restarts. See PRD/spec for the full storyboard.
const SCHEDULE: { at: number; do: 'show' | 'approve' | 'dismiss' | 'restart'; card?: CardId }[] = [
  { at: 500,  do: 'show',     card: 'optimizer' },
  { at: 3000, do: 'approve',  card: 'optimizer' },
  { at: 3400, do: 'dismiss',  card: 'optimizer' },
  { at: 4000, do: 'show',     card: 'refusal' },
  { at: 7000, do: 'dismiss',  card: 'refusal' },
  { at: 7400, do: 'show',     card: 'competitor' },
  { at: 9400, do: 'dismiss',  card: 'competitor' },
  { at: 9800, do: 'restart' },
];

const ACTIVITY_ITEMS = [
  { agent: 'ad optimizer', text: 'Refreshed Meta creative' },
  { agent: 'cro',          text: 'Hero rewrite shipped to West Roxbury' },
  { agent: 'content',      text: 'Scheduled 5 IG posts' },
  { agent: 'compliance',   text: 'Caught banned phrase before publish' },
];

const KPI_TARGETS = [94, 2, 1, 1] as const;

export function HeroPreview() {
  const prefersReducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeCard, setActiveCard] = useState<CardId | null>(null);
  const [approving, setApproving] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);

  // Pause/resume gates ────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0.3 },
    );
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setIsPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Loop scheduler ────────────────────────────────────────────────────────
  useEffect(() => {
    if (prefersReducedMotion) {
      // Reduced-motion: just show beat 1 statically.
      setActiveCard('optimizer');
      setApproving(false);
      return;
    }
    if (!isVisible || !isPageVisible) return;

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function schedule() {
      SCHEDULE.forEach((beat) => {
        timeouts.push(
          setTimeout(() => {
            if (beat.do === 'show') {
              setActiveCard(beat.card ?? null);
              setApproving(false);
            } else if (beat.do === 'approve') {
              setApproving(true);
            } else if (beat.do === 'dismiss') {
              setActiveCard((curr) => (curr === beat.card ? null : curr));
              setApproving(false);
            } else if (beat.do === 'restart') {
              schedule();
            }
          }, beat.at),
        );
      });
    }

    schedule();
    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [prefersReducedMotion, isVisible, isPageVisible]);

  return (
    <LazyMotion features={domAnimation} strict>
    <div
      ref={containerRef}
      className="mx-auto max-w-5xl rounded-xl shadow-lifted border border-ink-200/60 dark:border-ink-700/60 overflow-hidden bg-white dark:bg-ink-900"
      aria-label="Maroa War Room preview"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-2 px-4 py-3 bg-ink-50 dark:bg-ink-950/60 border-b border-ink-200/60 dark:border-ink-800">
        <span className="h-3 w-3 rounded-full bg-red-400/80" aria-hidden="true" />
        <span className="h-3 w-3 rounded-full bg-amber-400/80" aria-hidden="true" />
        <span className="h-3 w-3 rounded-full bg-green-400/80" aria-hidden="true" />
        <div className="mx-auto flex items-center gap-2 text-xs text-ink-400 font-mono">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          app.maroa.ai/dashboard
        </div>
      </div>

      {/* Inner app frame */}
      <div className="flex h-[420px] sm:h-[480px]">
        {/* Sidebar */}
        <div className="hidden sm:flex flex-col w-48 bg-ink-50/60 dark:bg-ink-950/40 border-r border-ink-200/60 dark:border-ink-800 p-4">
          <div className="flex items-center gap-2 mb-6 px-1">
            <span className="h-6 w-6 rounded-md bg-ink-700 dark:bg-white flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  className="text-white dark:text-ink-900"
                />
                <circle cx="12" cy="12" r="4" fill="currentColor" className="text-white dark:text-ink-900" />
              </svg>
            </span>
            <span className="text-sm font-semibold tracking-tight text-ink-700 dark:text-ink-100">Maroa</span>
          </div>
          <nav className="space-y-1">
            {[
              { label: 'War Room', active: true },
              { label: 'Content', active: false },
              { label: 'Ads', active: false },
              { label: 'Clients', active: false },
              { label: 'Settings', active: false },
            ].map((i) => (
              <div
                key={i.label}
                className={`text-xs px-3 py-1.5 rounded-lg ${
                  i.active
                    ? 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 font-medium'
                    : 'text-ink-400'
                }`}
              >
                {i.label}
              </div>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 p-5 sm:p-6 overflow-hidden">
          {/* Header */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider text-ink-400">Today</p>
            <h3 className="text-lg sm:text-xl font-semibold text-ink-700 dark:text-ink-100 mt-0.5 tracking-tight">
              War Room — 3 clients, 2 need approval
            </h3>
          </div>

          {/* KPI strip — counts up once on first mount */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-5">
            {KPI_TARGETS.map((target, i) => (
              <KpiCell
                key={i}
                label={['Live creatives', 'Pending', 'Tests running', 'Refusals 7d'][i]!}
                target={target}
                tone={i === 1 ? 'warn' : 'default'}
                delayMs={i * 80}
              />
            ))}
          </div>

          {/* Scripted card stage — single card visible at a time */}
          <div className="relative min-h-[170px]">
            <ShimmerEmptyState visible={activeCard === null} />
            <AnimatePresence mode="wait">
              {activeCard === 'optimizer' && (
                <CardShell key="optimizer">
                  <OptimizerCard approving={approving} />
                </CardShell>
              )}
              {activeCard === 'refusal' && (
                <CardShell key="refusal">
                  <RefusalCard />
                </CardShell>
              )}
              {activeCard === 'competitor' && (
                <CardShell key="competitor">
                  <CompetitorCard />
                </CardShell>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right rail — visible md+ */}
        <div className="hidden md:flex flex-col w-44 lg:w-52 bg-ink-50/40 dark:bg-ink-950/20 border-l border-ink-200/60 dark:border-ink-800 p-4">
          <p className="text-[10px] uppercase tracking-wider text-ink-400 flex items-center gap-1.5 mb-3">
            <Inbox className="h-3 w-3" />
            Approval inbox
          </p>
          <div className="space-y-2 mb-6">
            {[
              { client: 'Tirana Roastery', what: 'IG captions × 5' },
              { client: 'Smile Studio', what: 'Counter-offer copy' },
            ].map((a) => (
              <div
                key={a.client}
                className="rounded-lg border border-amber-200/60 dark:border-amber-500/20 bg-white dark:bg-ink-950/40 p-2"
              >
                <p className="text-[10px] text-ink-400">{a.client}</p>
                <p className="text-xs text-ink-700 dark:text-ink-100 truncate">{a.what}</p>
              </div>
            ))}
          </div>

          <p className="text-[10px] uppercase tracking-wider text-ink-400 flex items-center gap-1.5 mb-3">
            <Sparkles className="h-3 w-3" />
            Just shipped
          </p>
          <ActivityFeed paused={!isVisible || !isPageVisible} reduced={!!prefersReducedMotion} />
        </div>
      </div>
    </div>
    </LazyMotion>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: DURATION.moderate / 1000, ease: EASING_BEZIER.snappy }}
      className="absolute inset-0"
    >
      {children}
    </m.div>
  );
}

function ShimmerEmptyState({ visible }: { visible: boolean }) {
  return (
    <m.div
      aria-hidden={!visible}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.18 }}
      className="absolute inset-0 rounded-xl border border-dashed border-ink-200/60 dark:border-ink-800 bg-white/40 dark:bg-ink-950/20 overflow-hidden"
    >
      <div className="h-full w-full animate-pulse" />
    </m.div>
  );
}

function OptimizerCard({ approving }: { approving: boolean }) {
  return (
    <div
      className={`rounded-xl border bg-white dark:bg-ink-950/40 p-4 transition-shadow ${
        approving
          ? 'border-green-400/70 shadow-[0_0_0_3px_rgba(52,199,89,0.12)]'
          : 'border-ink-200/60 dark:border-ink-800'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200/60 dark:border-green-500/20 flex items-center justify-center flex-shrink-0">
          <TrendingUp className="h-4 w-4 text-green-700 dark:text-green-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">ad optimizer</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400">Tirana Roastery</span>
            <span className="ml-auto font-mono text-ink-400">2h ago</span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug">
            CTR on Meta image ad dropped 31% over 4 days. Refresh creative, not budget.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <ConfidenceRing target={0.87} />
            <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px]">
              <div>
                <dt className="inline text-ink-400">Upside · </dt>
                <dd className="inline text-ink-700 dark:text-ink-200 font-medium">+15% CTR</dd>
              </div>
              <div>
                <dt className="inline text-ink-400">Cost · </dt>
                <dd className="inline text-ink-700 dark:text-ink-200 font-medium">$0.30</dd>
              </div>
            </dl>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <AnimatePresence mode="wait">
              {approving ? (
                <m.span
                  key="approved"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.32, ease: EASING_BEZIER.bounce }}
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{ color: STATE_DOTS.green, backgroundColor: 'rgba(52,199,89,0.12)' }}
                >
                  <Check className="h-3 w-3" strokeWidth={2.6} />
                  Approved
                </m.span>
              ) : (
                <m.span
                  key="pending"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="inline-flex items-center gap-1 text-[10px] font-medium"
                  style={{ color: STATE_DOTS.green }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATE_DOTS.green }} />
                  Auto-executed
                </m.span>
              )}
            </AnimatePresence>
            <span className="text-ink-300">·</span>
            <span className="text-[10px] text-ink-400">approval gate cleared</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RefusalCard() {
  return (
    <div className="rounded-xl border border-red-200/60 dark:border-red-500/20 bg-red-50/30 dark:bg-red-500/5 p-4">
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 flex items-center justify-center flex-shrink-0">
          <ShieldCheck className="h-4 w-4 text-red-700 dark:text-red-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">compliance gate</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400">Acme Supplements</span>
            <span className="ml-auto inline-flex items-center gap-1" style={{ color: STATE_DOTS.red }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATE_DOTS.red }} />
              REFUSED
            </span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug">
            Banned health claim &ldquo;<span className="line-through decoration-red-500/70 decoration-2">cures fatigue</span>&rdquo;.
            Auto-substituted compliant variant.
          </p>
          <div className="mt-2 text-[11px] text-ink-500 dark:text-ink-300 italic leading-snug">
            &ldquo;Sustained, plant-based energy without the crash.&rdquo;
          </div>
          <div className="mt-2.5 flex items-center gap-2 text-[10px] text-ink-400">
            <Eye className="h-3 w-3" />
            Reasoning trace logged · FDA §201(g)
          </div>
        </div>
      </div>
    </div>
  );
}

function CompetitorCard() {
  return (
    <div className="rounded-xl border border-amber-200/60 dark:border-amber-500/20 bg-white dark:bg-ink-950/40 p-4">
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20 flex items-center justify-center flex-shrink-0">
          <AlertCircle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">competitor watch</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400">Tirana Roastery</span>
            <span className="ml-auto font-mono text-ink-400">just now</span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug">
            Brooklyn Roastery launched &ldquo;Happy Hour&rdquo; — 30% off espresso 3–5pm. Recommend test
            with weekday-evening segment.
          </p>
          <div className="mt-2.5 flex items-center gap-2 text-[10px]">
            <span className="px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 font-medium">
              A/B test ready
            </span>
            <span className="text-ink-400">est. cost $4 · 7d cohort</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Animated radial confidence ring — 0 → target over 600ms on mount.
function ConfidenceRing({ target }: { target: number }) {
  const pct = Math.round(target * 100);
  const r = 11;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-8 w-8 flex items-center justify-center">
      <svg width={28} height={28} viewBox="0 0 28 28" className="-rotate-90">
        <circle cx={14} cy={14} r={r} stroke="currentColor" className="text-ink-200 dark:text-ink-800" strokeWidth={2} fill="none" />
        <m.circle
          cx={14} cy={14} r={r}
          stroke={STATE_DOTS.green}
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
          initial={{ strokeDasharray: c, strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - target) }}
          transition={{ duration: DURATION.cinematic / 1000, ease: EASING_BEZIER.snappy }}
        />
      </svg>
      <span className="absolute text-[9px] font-semibold text-ink-700 dark:text-ink-100">{pct}</span>
    </div>
  );
}

// KPI cell with count-up on first mount.
function KpiCell({
  label,
  target,
  tone,
  delayMs,
}: {
  label: string;
  target: number;
  tone: 'default' | 'warn';
  delayMs: number;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [value, setValue] = useState(prefersReducedMotion ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion) return;
    let raf = 0;
    let start = 0;
    const total = 450;
    function tick(ts: number) {
      if (!start) start = ts;
      const elapsed = ts - start;
      if (elapsed < delayMs) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, (elapsed - delayMs) / total);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delayMs, prefersReducedMotion]);

  return (
    <div className="rounded-lg border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950/40 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-ink-400">{label}</p>
      <p
        className={`text-base sm:text-lg font-semibold tracking-tight mt-0.5 tabular-nums ${
          tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-ink-700 dark:text-ink-100'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// Right-rail activity feed — cycles items in every 4s.
function ActivityFeed({ paused, reduced }: { paused: boolean; reduced: boolean }) {
  const [head, setHead] = useState(0);
  useEffect(() => {
    if (reduced || paused) return;
    const id = setInterval(() => {
      setHead((h) => (h + 1) % ACTIVITY_ITEMS.length);
    }, 4000);
    return () => clearInterval(id);
  }, [paused, reduced]);

  const visible = [
    ACTIVITY_ITEMS[head]!,
    ACTIVITY_ITEMS[(head + 1) % ACTIVITY_ITEMS.length]!,
    ACTIVITY_ITEMS[(head + 2) % ACTIVITY_ITEMS.length]!,
  ];

  return (
    <ol className="space-y-2.5 text-[10px] text-ink-700 dark:text-ink-200">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((item, i) => (
          <m.li
            key={`${head}-${i}-${item.agent}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: DURATION.quick / 1000, ease: EASING_BEZIER.snappy }}
            className="leading-snug"
          >
            <span className="text-ink-400">{item.agent} · </span>
            {item.text}
          </m.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
