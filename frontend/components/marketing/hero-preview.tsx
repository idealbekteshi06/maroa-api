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

type CardId = 'optimizer' | 'wins' | 'refusal' | 'fix' | 'competitor';
type FeedCard = { uid: string; type: CardId };

// Feed schedule (ms from loop start) — narrative arc, not just a rotation.
// The 5 beats escalate:
//   1. Small win    — ad-optimizer fires + auto-approves (system is on)
//   2. Bigger win   — 24h wins summary (system is paying off)
//   3. Friction     — compliance refusal (system catches problems)
//   4. Resolution   — auto-substituted compliant copy (system fixes them)
//   5. Strategic    — competitor watch flags a counter-move (system thinks)
// Cards still cap at MAX_FEED — the oldest beat shifts out as new ones
// land so the feed shows the most recent moments without losing density.
const MAX_FEED = 3;
const FEED_SCHEDULE: { at: number; do: 'show' | 'approve' | 'restart'; card?: CardId }[] = [
  { at: 600,   do: 'show',    card: 'optimizer' },   // Beat 1 — small win
  { at: 2800,  do: 'approve' },                       //          auto-approves
  { at: 4500,  do: 'show',    card: 'wins' },        // Beat 2 — bigger win
  { at: 8000,  do: 'show',    card: 'refusal' },     // Beat 3 — friction
  { at: 11500, do: 'show',    card: 'fix' },         // Beat 4 — resolution
  { at: 15000, do: 'show',    card: 'competitor' },  // Beat 5 — strategic
  { at: 19000, do: 'restart' },
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
  // Newest card lives at the END of `cards` — feed renders bottom-to-top
  // visually so newcomers appear at the top.
  const [cards, setCards] = useState<FeedCard[]>([]);
  // Approve beat fires once on the very first optimizer card only.
  const [firstApprovingUid, setFirstApprovingUid] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const uidCounter = useRef(0);
  const isFirstLoopRef = useRef(true);

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
      // Reduced-motion: render 3 representative beats from the narrative
      // arc statically — same density, no loop. Picks the most distinct
      // moments (wins summary, refusal-then-fix pairing).
      const staticUid = 'static';
      setCards([
        { uid: `${staticUid}-wins`, type: 'wins' },
        { uid: `${staticUid}-ref`, type: 'refusal' },
        { uid: `${staticUid}-fix`, type: 'fix' },
      ]);
      setFirstApprovingUid(null);
      return;
    }
    if (!isVisible || !isPageVisible) return;

    const timeouts: ReturnType<typeof setTimeout>[] = [];

    function schedule() {
      FEED_SCHEDULE.forEach((beat) => {
        timeouts.push(
          setTimeout(() => {
            if (beat.do === 'show' && beat.card) {
              const uid = `c-${++uidCounter.current}`;
              const cardType = beat.card;
              // First optimizer of the first loop only — flag for the
              // approve beat that follows.
              if (cardType === 'optimizer' && isFirstLoopRef.current && firstApprovingUid === null) {
                setFirstApprovingUid(uid);
              }
              setCards((prev) => {
                const next = [...prev, { uid, type: cardType }];
                return next.length > MAX_FEED ? next.slice(next.length - MAX_FEED) : next;
              });
            } else if (beat.do === 'approve') {
              // Already flagged at show-time; nothing to do here. Kept for
              // schedule clarity + future expansion.
            } else if (beat.do === 'restart') {
              isFirstLoopRef.current = false;
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
  // firstApprovingUid only matters at the moment we push the first card;
  // intentionally excluded from deps so the loop doesn't re-arm when it flips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReducedMotion, isVisible, isPageVisible]);

  return (
    <LazyMotion features={domAnimation} strict>
    <div
      ref={containerRef}
      className="mx-auto max-w-5xl rounded-xl shadow-lifted border border-ink-200/60 dark:border-ink-700/60 overflow-hidden bg-white dark:bg-ink-900"
      aria-label="Maroa War Room preview"
    >
      {/* Tabbed window chrome — traffic lights + 3 browser tabs */}
      <div className="flex items-center gap-3 px-4 pt-3 bg-ink-50 dark:bg-ink-950/60 border-b border-ink-200/60 dark:border-ink-800">
        <div className="flex items-center gap-1.5 pb-3 flex-shrink-0">
          <span className="h-3 w-3 rounded-full bg-red-400/80" aria-hidden="true" />
          <span className="h-3 w-3 rounded-full bg-amber-400/80" aria-hidden="true" />
          <span className="h-3 w-3 rounded-full bg-green-400/80" aria-hidden="true" />
        </div>
        <div className="flex items-end gap-1 overflow-hidden -mb-px">
          {[
            { label: 'War Room', active: true, status: 'green' as const },
            { label: 'Smile Studio', active: false },
            { label: 'Tirana Roastery', active: false },
          ].map((tab) => (
            <div
              key={tab.label}
              className={
                'group flex items-center gap-2 px-3 py-2 text-xs rounded-t-md border-t border-l border-r transition-colors ' +
                (tab.active
                  ? 'border-ink-200/60 dark:border-ink-700/60 bg-white dark:bg-ink-900 text-ink-700 dark:text-ink-100 font-medium relative'
                  : 'border-transparent text-ink-400 hover:text-ink-700 dark:hover:text-ink-200')
              }
            >
              {tab.status === 'green' && (
                <span
                  className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: STATE_DOTS.green }}
                  aria-hidden="true"
                />
              )}
              <span className="truncate max-w-[120px]">{tab.label}</span>
              {tab.active && (
                <span
                  aria-hidden="true"
                  className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full"
                  style={{ backgroundColor: STATE_DOTS.blue }}
                />
              )}
            </div>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5 pb-3 text-[10px] text-ink-400 font-mono flex-shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          app.maroa.ai
        </div>
      </div>

      {/* Inner app frame */}
      <div className="relative flex h-[420px] sm:h-[480px]">
        <FloatingToast active={isVisible && isPageVisible} reduced={!!prefersReducedMotion} />
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

          {/* Stacked feed — cards accumulate, max 3, newest at top */}
          <div className="relative min-h-[280px]">
            <ShimmerEmptyState visible={cards.length === 0} />
            <div className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {[...cards].reverse().map((card) => (
                  <m.div
                    key={card.uid}
                    layout
                    initial={{ opacity: 0, y: -16, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
                    transition={{
                      duration: DURATION.moderate / 1000,
                      ease: EASING_BEZIER.snappy,
                      layout: { duration: DURATION.moderate / 1000, ease: EASING_BEZIER.snappy },
                    }}
                  >
                    {card.type === 'optimizer' && (
                      <OptimizerCard approving={card.uid === firstApprovingUid} />
                    )}
                    {card.type === 'wins' && <WinsCard />}
                    {card.type === 'refusal' && <RefusalCard />}
                    {card.type === 'fix' && <FixCard />}
                    {card.type === 'competitor' && <CompetitorCard />}
                  </m.div>
                ))}
              </AnimatePresence>
            </div>
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
      className={`rounded-xl border bg-white dark:bg-ink-950/40 p-3 transition-shadow ${
        approving
          ? 'border-green-400/70 shadow-[0_0_0_3px_rgba(52,199,89,0.12)]'
          : 'border-ink-200/60 dark:border-ink-800'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200/60 dark:border-green-500/20 flex items-center justify-center flex-shrink-0">
          <TrendingUp className="h-3.5 w-3.5 text-green-700 dark:text-green-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">ad optimizer</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400 truncate">Tirana Roastery</span>
            <span className="ml-auto font-mono text-ink-400 flex-shrink-0">2h ago</span>
          </div>
          <p className="text-xs text-ink-700 dark:text-ink-100 leading-snug">
            CTR on Meta image ad dropped 31% over 4 days. Refresh creative, not budget.
          </p>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <AnimatePresence mode="wait" initial={false}>
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
            <span className="text-[10px] text-ink-400">+15% CTR · $0.30 · 87% conf.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RefusalCard() {
  return (
    <div className="rounded-xl border border-red-200/60 dark:border-red-500/20 bg-red-50/30 dark:bg-red-500/5 p-3">
      <div className="flex items-start gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 flex items-center justify-center flex-shrink-0">
          <ShieldCheck className="h-3.5 w-3.5 text-red-700 dark:text-red-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">compliance gate</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400 truncate">Acme Supplements</span>
            <span className="ml-auto inline-flex items-center gap-1 flex-shrink-0" style={{ color: STATE_DOTS.red }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATE_DOTS.red }} />
              REFUSED
            </span>
          </div>
          <p className="text-xs text-ink-700 dark:text-ink-100 leading-snug">
            Banned health claim &ldquo;<span className="line-through decoration-red-500/70 decoration-2">cures fatigue</span>&rdquo;.
            Auto-substituted compliant variant.
          </p>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-400">
            <Eye className="h-3 w-3" />
            Reasoning trace · FDA §201(g)
          </div>
        </div>
      </div>
    </div>
  );
}

function CompetitorCard() {
  return (
    <div className="rounded-xl border border-amber-200/60 dark:border-amber-500/20 bg-white dark:bg-ink-950/40 p-3">
      <div className="flex items-start gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20 flex items-center justify-center flex-shrink-0">
          <AlertCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">competitor watch</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400 truncate">Tirana Roastery</span>
            <span className="ml-auto font-mono text-ink-400 flex-shrink-0">just now</span>
          </div>
          <p className="text-xs text-ink-700 dark:text-ink-100 leading-snug">
            Brooklyn Roastery launched &ldquo;Happy Hour&rdquo; — 30% off espresso 3–5pm. Recommend test
            with weekday-evening segment.
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] flex-wrap">
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

// Beat 2 — "bigger win" summary card. Three live agents shipping
// quantified outcomes in the last 24h. Reads as "the system is paying off."
function WinsCard() {
  const lines = [
    { agent: 'ad optimizer', delta: '+$2,140', text: 'Meta CTR refresh on 4 ads' },
    { agent: 'cro',          delta: '+18%',    text: 'Landing-page hero rewrite shipped' },
    { agent: 'content',      delta: '5 / 5',   text: 'IG captions approved + scheduled' },
  ];
  return (
    <div className="rounded-xl border bg-white dark:bg-ink-950/40 p-3"
         style={{ borderColor: 'rgba(81,69,229,0.30)' }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATE_DOTS.blue }} />
          <span className="text-ink-700 dark:text-ink-100 font-medium">Last 24h · 3 wins</span>
        </div>
        <span className="text-[10px] font-mono text-ink-400">attributable</span>
      </div>
      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li key={l.agent} className="flex items-start gap-2.5 text-[11px] leading-snug">
            <span
              className="font-mono tabular-nums font-semibold flex-shrink-0 w-12"
              style={{ color: STATE_DOTS.blue }}
            >
              {l.delta}
            </span>
            <span className="text-ink-700 dark:text-ink-100 flex-1 min-w-0">
              <span className="text-ink-400">{l.agent} · </span>
              {l.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Beat 4 — "resolution" of the compliance refusal in Beat 3. Same agent,
// same business, but now showing the auto-substituted compliant copy. Reads
// as: refusals don't block the work, they reshape it.
function FixCard() {
  return (
    <div className="rounded-xl border border-green-200/60 dark:border-green-500/20 bg-green-50/30 dark:bg-green-500/5 p-3">
      <div className="flex items-start gap-2.5">
        <div className="h-7 w-7 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200/60 dark:border-green-500/20 flex items-center justify-center flex-shrink-0">
          <Check className="h-3.5 w-3.5 text-green-700 dark:text-green-300" strokeWidth={2.6} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5 text-[10px] uppercase tracking-wider">
            <span className="text-ink-400">compliance · auto-fix</span>
            <span className="text-ink-300">·</span>
            <span className="text-ink-400 truncate">Acme Supplements</span>
            <span className="ml-auto inline-flex items-center gap-1 flex-shrink-0" style={{ color: STATE_DOTS.green }}>
              shipped
            </span>
          </div>
          <p className="text-xs text-ink-700 dark:text-ink-100 leading-snug italic">
            &ldquo;Sustained, plant-based energy without the crash.&rdquo;
          </p>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-400">
            FDA §201(g) clean · 3 gates passed · 0 ms delay vs original
          </div>
        </div>
      </div>
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

// Top-right floating toast — "Maroa drafted 5 posts". Slides in 5s after
// the hero becomes visible, dismisses after 4s. Reduced-motion: rendered
// statically (no slide, no auto-dismiss).
function FloatingToast({ active, reduced }: { active: boolean; reduced: boolean }) {
  const [show, setShow] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      setShow(true);
      return;
    }
    if (!active) return;
    const showId = setTimeout(() => setShow(true), 5000);
    const hideId = setTimeout(() => setShow(false), 5000 + 4000);
    return () => {
      clearTimeout(showId);
      clearTimeout(hideId);
    };
  }, [active, reduced]);

  return (
    <AnimatePresence>
      {show && (
        <m.div
          key="toast"
          role="status"
          initial={reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 1 } : { opacity: 0, y: -8 }}
          transition={{ duration: DURATION.moderate / 1000, ease: EASING_BEZIER.snappy }}
          className="absolute top-3 right-3 z-20 flex items-center gap-2 pr-3 pl-2.5 py-2 rounded-full bg-white/95 dark:bg-ink-900/95 border border-ink-200/60 dark:border-ink-700/60 shadow-card backdrop-blur-md"
        >
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span
              className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
              style={{ backgroundColor: STATE_DOTS.green }}
            />
            <span
              className="relative inline-flex h-2 w-2 rounded-full"
              style={{ backgroundColor: STATE_DOTS.green }}
            />
          </span>
          <span className="text-[11px] font-medium text-ink-700 dark:text-ink-100 leading-none">
            Maroa drafted 5 posts
          </span>
          <span className="text-[10px] text-ink-400 font-mono leading-none">just now</span>
        </m.div>
      )}
    </AnimatePresence>
  );
}
