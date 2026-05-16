'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  LazyMotion,
  domAnimation,
  m,
  useReducedMotion,
} from 'framer-motion';
import { Check, X, ShieldAlert, TrendingUp, FileCheck, Sparkles, Globe2 } from 'lucide-react';
import { DURATION, EASING_BEZIER, STATE_DOTS } from '@/lib/design-tokens';

/**
 * Visual proof tiles for the /features page. Four of them have looping
 * micro-animations that play when the tile is in viewport — reasoning
 * trace, compliance refusal, ad audit, client approval. The other five
 * are static (the proof is the layout itself).
 *
 * All loops respect prefers-reduced-motion: end-state is rendered,
 * no animation. All loops pause when off-screen via IntersectionObserver.
 *
 * One LazyMotion provider wraps each animated tile — strict mode keeps
 * us honest about using `m` everywhere instead of `motion`.
 */

type ProofKind =
  | 'reasoning-trace'
  | 'compliance-refusal'
  | 'ad-audit-decision'
  | 'client-approval'
  | 'auto-safe-band'
  | 'channel-format'
  | 'voice-signature'
  | 'cultural-calendar'
  | 'multi-locale';

export function FeatureProof({ kind }: { kind: ProofKind }) {
  switch (kind) {
    case 'reasoning-trace':
      return <ReasoningTrace />;
    case 'compliance-refusal':
      return <ComplianceRefusal />;
    case 'ad-audit-decision':
      return <AdAuditDecision />;
    case 'client-approval':
      return <ClientApproval />;
    case 'auto-safe-band':
      return <AutoSafeBand />;
    case 'channel-format':
      return <ChannelFormat />;
    case 'voice-signature':
      return <VoiceSignature />;
    case 'cultural-calendar':
      return <CulturalCalendar />;
    case 'multi-locale':
      return <MultiLocale />;
    default:
      return null;
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-5 shadow-subtle">
      {children}
    </div>
  );
}

// ─── Shared hook: intersection observer + tick driver ────────────────────────

function useInViewport<T extends HTMLElement>(threshold = 0.4) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(([e]) => setInView(e.isIntersecting), {
      threshold,
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

// Drives a "beat" counter that increments every `intervalMs` while
// `active`, resetting to 0 after `beats` cycles. Pauses cleanly when
// active flips false.
function useLoopBeat(intervalMs: number, beats: number, active: boolean): number {
  const [b, setB] = useState(0);
  useEffect(() => {
    if (!active) return;
    setB(0);
    const id = setInterval(() => setB((x) => (x + 1) % beats), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, beats]);
  return b;
}

// ─── Tile 1 — Reasoning trace (lines stagger in, loop) ───────────────────────

function ReasoningTrace() {
  const prefersReducedMotion = useReducedMotion();
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const active = !!inView && !prefersReducedMotion;
  // 6 lines reveal over ~1.2s (200ms each), 2s pause, then loop = 3.2s/cycle.
  const beat = useLoopBeat(3200, 1, active);
  const rows = [
    { label: 'Framework', value: 'Hormozi value-stack' },
    { label: 'Awareness stage', value: 'problem-aware' },
    { label: 'Hook type', value: 'scarcity_with_proof' },
    { label: 'Past performance signal', value: '+34% on similar pour-over launches' },
    { label: 'Voice fit', value: '0.91 / 1.0', tone: 'good' as const },
    { label: 'Compliance', value: 'passed (5 gates)', tone: 'good' as const },
  ];

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={ref}>
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <FileCheck className="h-4 w-4 text-accent-500" />
            <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">Reasoning trace</p>
            <span className="ml-auto text-[10px] font-mono text-ink-400">draft #1842</span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 font-medium leading-snug">
            &ldquo;Father&apos;s Day weekend — first 30 reservations get a complimentary pour-over.&rdquo;
            {active && <Caret />}
          </p>
          <dl className="space-y-1.5 text-xs">
            {rows.map((r, i) => (
              <m.div
                key={`${beat}-${i}`}
                initial={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: DURATION.quick / 1000,
                  delay: prefersReducedMotion ? 0 : 0.2 * i,
                  ease: EASING_BEZIER.snappy,
                }}
              >
                <Row label={r.label} value={r.value} tone={r.tone} />
              </m.div>
            ))}
          </dl>
        </Card>
      </div>
    </LazyMotion>
  );
}

function Caret() {
  return (
    <m.span
      aria-hidden="true"
      className="inline-block w-[2px] h-[1em] align-middle ml-0.5"
      style={{ backgroundColor: 'currentColor' }}
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
    />
  );
}

// ─── Tile 2 — Compliance refusal (strikethrough sweeps across) ───────────────

function ComplianceRefusal() {
  const prefersReducedMotion = useReducedMotion();
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const active = !!inView && !prefersReducedMotion;
  // 600ms sweep, 3000ms hold, total 3600ms cycle.
  const beat = useLoopBeat(3600, 1, active);

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={ref}>
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="h-4 w-4 text-red-500" />
            <p className="text-xs uppercase tracking-wider text-red-700 dark:text-red-400 font-medium">
              Refused
            </p>
            <span className="ml-auto text-[10px] font-mono text-ink-400">FDA / supplements</span>
          </div>
          <p className="relative text-sm text-ink-700 dark:text-ink-100 mb-2 leading-snug">
            <span className="relative inline">
              &ldquo;Cures chronic fatigue in 14 days — guaranteed.&rdquo;
              <m.span
                key={beat}
                aria-hidden="true"
                className="absolute left-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
                style={{ backgroundColor: STATE_DOTS.red }}
                initial={prefersReducedMotion ? { width: '100%' } : { width: 0 }}
                animate={{ width: '100%' }}
                transition={{
                  duration: prefersReducedMotion ? 0 : DURATION.cinematic / 1000,
                  ease: EASING_BEZIER.snappy,
                }}
              />
            </span>
          </p>
          <div className="rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 p-3">
            <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">
              Banned claim: &ldquo;cures&rdquo;
            </p>
            <p className="text-xs text-red-800/80 dark:text-red-300/80 leading-snug">
              Suggested rewrite: &ldquo;Supports natural energy levels.&rdquo; FDA-compliant, passes
              three gates.
            </p>
          </div>
        </Card>
      </div>
    </LazyMotion>
  );
}

// ─── Tile 3 — Ad audit decision (count-up + recommend-pause badge) ───────────

function AdAuditDecision() {
  const prefersReducedMotion = useReducedMotion();
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const active = !!inView && !prefersReducedMotion;
  // 4 beats: 0 reset, 1 numbers settle, 2 numbers settled, 3 badge appears.
  const beat = useLoopBeat(1000, 4, active);
  const showBadge = beat >= 3 || prefersReducedMotion;

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={ref}>
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-accent-500" />
            <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">Ad audit · 09:14</p>
            <span className="ml-auto text-[10px] font-mono text-ink-400">meta · cafe-launch-04</span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 leading-snug">
            CTR dropped{' '}
            <span className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
              <Counter key={`ctr-${beat === 0 ? 'r' : 's'}`} target={31} suffix="%" active={active} />
            </span>{' '}
            over 4 days. Recommendation: refresh creative, not budget.
          </p>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <CellWithCounter label="Expected upside" target={15} suffix="% CTR" tone="good" active={active} resetKey={beat} />
            <Cell label="Risk" value="Low" />
            <CellWithCounter label="Confidence" target={84} suffix="%" active={active} resetKey={beat} />
          </dl>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 uppercase tracking-wider">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Auto-executed
            </span>
            <span className="text-[10px] text-ink-400 font-mono">$0.30 cost</span>
            <AnimatePresence>
              {showBadge && (
                <m.span
                  key="pause-badge"
                  initial={prefersReducedMotion ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: DURATION.moderate / 1000, ease: EASING_BEZIER.bounce }}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{
                    color: STATE_DOTS.amber,
                    backgroundColor: 'rgba(255,149,0,0.12)',
                  }}
                >
                  Recommend pause
                </m.span>
              )}
            </AnimatePresence>
          </div>
        </Card>
      </div>
    </LazyMotion>
  );
}

function Counter({ target, suffix, active }: { target: number; suffix: string; active: boolean }) {
  const [v, setV] = useState(active ? 0 : target);
  useEffect(() => {
    if (!active) {
      setV(target);
      return;
    }
    let raf = 0;
    let start = 0;
    const duration = 450;
    function tick(ts: number) {
      if (!start) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active]);
  return (
    <>
      {v}
      {suffix}
    </>
  );
}

function CellWithCounter({
  label,
  target,
  suffix,
  tone,
  active,
  resetKey,
}: {
  label: string;
  target: number;
  suffix: string;
  tone?: 'good';
  active: boolean;
  resetKey: number;
}) {
  return (
    <div className="rounded-lg bg-ink-50 dark:bg-ink-800/60 px-2 py-1.5">
      <p className="text-[10px] text-ink-400 uppercase tracking-wider">{label}</p>
      <p
        className={`tabular-nums text-xs mt-0.5 font-semibold ${
          tone === 'good' ? 'text-green-700 dark:text-green-400' : 'text-ink-700 dark:text-ink-100'
        }`}
      >
        <Counter key={`${resetKey === 0 ? 'r' : 's'}-${target}`} target={target} suffix={suffix} active={active} />
      </p>
    </div>
  );
}

// ─── Tile 4 — Client approval (Approve → OptimisticCheck → reset) ────────────

function ClientApproval() {
  const prefersReducedMotion = useReducedMotion();
  const [ref, inView] = useInViewport<HTMLDivElement>();
  const active = !!inView && !prefersReducedMotion;
  // 3 beats: 0 idle, 1 approved (1s), 2 hold approved (1s). 3s total cycle.
  const beat = useLoopBeat(1000, 3, active);
  const approved = beat >= 1 || prefersReducedMotion;

  return (
    <LazyMotion features={domAnimation} strict>
      <div ref={ref}>
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-accent-500" />
            <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">
              Client magic-link
            </p>
            <span className="ml-auto text-[10px] font-mono text-ink-400">tiranaroastery.al</span>
          </div>
          <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 leading-snug">
            Maroa drafted 5 Instagram captions for Father&apos;s Day weekend.{' '}
            <span className="text-ink-400">All passed compliance.</span>
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <m.button
              type="button"
              animate={{
                backgroundColor: approved && !prefersReducedMotion ? STATE_DOTS.green : undefined,
              }}
              transition={{ duration: DURATION.quick / 1000 }}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900"
            >
              <AnimatePresence mode="wait" initial={false}>
                {approved ? (
                  <m.span
                    key="check"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: DURATION.moderate / 1000, ease: EASING_BEZIER.bounce }}
                    className="inline-flex"
                  >
                    <Check className="h-3 w-3" strokeWidth={2.8} />
                  </m.span>
                ) : (
                  <m.span
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="inline-flex"
                  >
                    <Check className="h-3 w-3" />
                  </m.span>
                )}
              </AnimatePresence>
              {approved ? 'Approved all 5' : 'Approve all 5'}
            </m.button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full text-ink-400"
            >
              <X className="h-3 w-3" />
              Reject
            </button>
            <span className="text-[10px] text-ink-400 font-mono ml-auto">expires in 64h</span>
          </div>
        </Card>
      </div>
    </LazyMotion>
  );
}

// ─── Tile 5–9 — static. Visual-only proof. ───────────────────────────────────

function AutoSafeBand() {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-4">
        Auto-safe banding
      </p>
      <ul className="space-y-3">
        <BandRow
          tone="green"
          label="Green — auto-publish"
          body="Low-stakes creative refresh on a campaign you&apos;ve already approved."
        />
        <BandRow
          tone="yellow"
          label="Yellow — notify operator"
          body="Brand-sensitive copy or new audience. Goes live after your tap."
        />
        <BandRow
          tone="red"
          label="Red — never auto-publish"
          body="Regulated industry, above-threshold spend, or first-time campaign."
        />
      </ul>
    </Card>
  );
}

function ChannelFormat() {
  const chips = [
    { name: 'Reels', count: 6 },
    { name: 'LinkedIn post', count: 1 },
    { name: 'Email promo', count: 1 },
    { name: 'TikTok hook', count: 3 },
    { name: 'Meta ad', count: 4 },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3">
        One idea → six surfaces
      </p>
      <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug mb-3 font-medium">
        Father&apos;s Day pour-over launch
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span
            key={c.name}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100"
          >
            {c.name}
            <span className="text-ink-400 font-mono">{c.count}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function VoiceSignature() {
  const traits = [
    { label: 'Formality', value: 0.32 },
    { label: 'Energy', value: 0.74 },
    { label: 'Humor', value: 0.58 },
    { label: 'Technicality', value: 0.21 },
    { label: 'Sentence rhythm', value: 0.66 },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-4">
        Voice signature
      </p>
      <ul className="space-y-2.5">
        {traits.map((t) => (
          <li key={t.label} className="flex items-center gap-3 text-xs">
            <span className="text-ink-400 w-32 flex-shrink-0">{t.label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-ink-100 dark:bg-ink-800 overflow-hidden">
              <div
                className="h-full bg-accent-500 rounded-full"
                style={{ width: `${Math.round(t.value * 100)}%` }}
              />
            </div>
            <span className="font-mono text-ink-700 dark:text-ink-100 w-10 text-right">
              {t.value.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-400">
        Drift &gt; 0.15 triggers automatic rewrite, not a warning.
      </p>
    </Card>
  );
}

function CulturalCalendar() {
  const rows = [
    { date: 'Sep 11', region: 'US', action: 'Pause promotional content', tone: 'amber' as const },
    { date: 'Ramadan', region: 'MENA', action: 'Alcohol marketing paused', tone: 'amber' as const },
    { date: 'Christmas', region: 'IT', action: 'Family-first tone', tone: 'green' as const },
    { date: 'Yom Kippur', region: 'IL', action: 'Auto-pause all', tone: 'amber' as const },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3">
        Cultural calendar
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.date + r.region}
            className="flex items-center gap-3 text-xs py-1.5 border-b border-ink-100 dark:border-ink-800 last:border-0"
          >
            <span className="font-mono text-ink-700 dark:text-ink-100 w-20">{r.date}</span>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 font-mono">
              {r.region}
            </span>
            <span
              className={
                r.tone === 'amber'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-green-700 dark:text-green-400'
              }
            >
              {r.action}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MultiLocale() {
  const samples = [
    {
      lang: 'SQ',
      label: 'Albanian café',
      copy: '“Mëngjes me byrek nga zonja Drita. Rruga e Durrësit, 8 të mëngjesit.”',
    },
    {
      lang: 'IT',
      label: 'Italian retail',
      copy: '“Saldi di mezza stagione. Solo questo weekend — ti aspettiamo.”',
    },
    { lang: 'AR', label: 'Saudi e-com', copy: '“توصيل خلال ساعتين داخل الرياض.”' },
  ];
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Globe2 className="h-4 w-4 text-accent-500" />
        <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">
          Native, not translated
        </p>
      </div>
      <ul className="space-y-3">
        {samples.map((s) => (
          <li key={s.lang} className="flex items-start gap-3">
            <span className="font-mono text-[10px] text-ink-400 w-8 mt-1">{s.lang}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-ink-400">{s.label}</p>
              <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug mt-0.5">{s.copy}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─── Shared primitives ───────────────────────────────────────────────────────

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd
        className={
          tone === 'good'
            ? 'text-green-700 dark:text-green-400 font-medium'
            : 'text-ink-700 dark:text-ink-100 font-medium'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div className="rounded-lg bg-ink-50 dark:bg-ink-800/60 px-2 py-1.5">
      <p className="text-[10px] text-ink-400 uppercase tracking-wider">{label}</p>
      <p
        className={
          tone === 'good'
            ? 'text-green-700 dark:text-green-400 font-semibold text-xs mt-0.5'
            : 'text-ink-700 dark:text-ink-100 font-semibold text-xs mt-0.5'
        }
      >
        {value}
      </p>
    </div>
  );
}

function BandRow({
  tone,
  label,
  body,
}: {
  tone: 'green' | 'yellow' | 'red';
  label: string;
  body: string;
}) {
  const tones = {
    green: 'bg-green-500',
    yellow: 'bg-amber-500',
    red: 'bg-red-500',
  } as const;
  return (
    <li className="flex items-start gap-3">
      <span className={`mt-1.5 h-2 w-2 rounded-full ${tones[tone]} flex-shrink-0`} />
      <div>
        <p className="text-sm font-semibold text-ink-700 dark:text-ink-100">{label}</p>
        <p className="text-xs text-ink-400 leading-snug mt-0.5">{body}</p>
      </div>
    </li>
  );
}
