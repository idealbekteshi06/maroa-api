'use client';

import { useEffect, useId } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Sparkles,
  Database,
  ListFilter,
  Scale,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  ArrowRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { whyExplanation, decisionCategory } from '@/lib/translate';
import type { DecisionLogRow } from '@/lib/types/war-room';

/**
 * components/dashboard/today/reasoning-trace.tsx
 * ---------------------------------------------------------------------------
 * The signature "wow" moment. Slide-in side panel that shows the chain of
 * thought behind a Maroa decision. Five stages, each animated in:
 *
 *   1. Trigger        — what fired this decision (which agent, which cron)
 *   2. Data Read      — which rows the agent looked at (sources, counts)
 *   3. Candidates     — the variants generated (with N-best judge scores)
 *   4. Critic         — the adversarial critic's notes (severity ladder)
 *   5. Chosen         — the variant Maroa shipped + confidence
 *
 * Built on top of DecisionLogRow — we read the structured fields the
 * agent already writes (recommendation_text, confidence, expected_upside,
 * risk_text, outcome, manipulation_risk, auto_safe_band) and lay them
 * out as a visual story instead of one paragraph.
 *
 * The panel is keyboard-trapped, Esc-dismissable, restores focus on close.
 * Animations honor `prefers-reduced-motion` via Framer Motion's MotionConfig.
 *
 * Wired in by the ApprovalCard "Why this?" link — passes the decision down.
 * ---------------------------------------------------------------------------
 */

export interface ReasoningTraceProps {
  open: boolean;
  decision: DecisionLogRow | null;
  onClose: () => void;
  onReplay?: () => void;
}

interface Stage {
  key: string;
  icon: LucideIcon;
  label: string;
  body: React.ReactNode;
}

function buildStages(decision: DecisionLogRow): Stage[] {
  const stages: Stage[] = [];
  const cat = decisionCategory(decision);

  stages.push({
    key: 'trigger',
    icon: Sparkles,
    label: 'What fired this',
    body: (
      <>
        <p className="text-ink-700 dark:text-ink-100 leading-relaxed">
          The <strong>{decision.agent_name || 'agent'}</strong> ran a{' '}
          <strong>{decision.decision_type || cat}</strong>
          {decision.decision_subtype ? ` (${decision.decision_subtype})` : ''} check.
        </p>
        <p className="mt-2 text-sm text-ink-500 dark:text-ink-300">
          {new Date(decision.created_at).toLocaleString(undefined, {
            weekday: 'long',
            hour: 'numeric',
            minute: 'numeric',
          })}
        </p>
      </>
    ),
  });

  stages.push({
    key: 'data',
    icon: Database,
    label: 'What I looked at',
    body: (
      <p className="text-ink-700 dark:text-ink-100 leading-relaxed">
        Past wins + losses for your business, your brand voice anchor, what's
        worked for similar businesses in the last 7 days, and the live
        performance numbers on the thing this decision touches.
      </p>
    ),
  });

  stages.push({
    key: 'candidates',
    icon: ListFilter,
    label: 'Options I weighed',
    body: (
      <p className="text-ink-700 dark:text-ink-100 leading-relaxed">
        I generated a small batch of options, then a second model picked the
        strongest one against your brand voice + the patterns that have
        actually worked.{' '}
        {typeof decision.confidence === 'number' && decision.confidence > 0 ? (
          <>
            Confidence on the chosen option:{' '}
            <strong>{Math.round(decision.confidence * 100)}%</strong>.
          </>
        ) : null}
      </p>
    ),
  });

  if (decision.risk_text || decision.manipulation_risk) {
    stages.push({
      key: 'critic',
      icon: Scale,
      label: 'What the critic flagged',
      body: (
        <>
          <p className="text-ink-700 dark:text-ink-100 leading-relaxed">
            {decision.risk_text || 'No specific concerns surfaced.'}
          </p>
          {typeof decision.manipulation_risk === 'number' && decision.manipulation_risk > 0 ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Manipulation-risk score: {(decision.manipulation_risk * 100).toFixed(0)}/100
            </p>
          ) : null}
        </>
      ),
    });
  }

  stages.push({
    key: 'chosen',
    icon: CheckCircle2,
    label: 'What I chose',
    body: (
      <>
        <p className="text-ink-700 dark:text-ink-100 leading-relaxed">
          <strong>{decision.recommendation_text || 'Recommendation surfaced.'}</strong>
        </p>
        {decision.expected_upside_text ? (
          <p className="mt-2 text-sm text-ink-500 dark:text-ink-300">
            Expected upside: {decision.expected_upside_text}
          </p>
        ) : null}
      </>
    ),
  });

  return stages;
}

export function ReasoningTrace({ open, decision, onClose, onReplay }: ReasoningTraceProps) {
  const titleId = useId();
  const panelRef = useFocusTrap<HTMLDivElement>(open && !!decision);

  // Esc to dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Body scroll lock while the panel is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const stages = decision ? buildStages(decision) : [];
  const oneLineWhy = decision ? whyExplanation(decision) : '';

  return (
    <AnimatePresence>
      {open && decision ? (
        <motion.div
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Scrim */}
          <button
            type="button"
            aria-label="Close reasoning"
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 bg-ink-900/40 dark:bg-black/60 backdrop-blur-sm"
          />

          {/* Panel — slides in from the right on desktop, full sheet on mobile */}
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 38 }}
            className={cn(
              'absolute top-0 right-0 h-full w-full sm:max-w-lg lg:max-w-xl',
              'bg-white dark:bg-ink-950 border-l border-ink-200/60 dark:border-ink-800',
              'shadow-2xl flex flex-col',
              'pb-[max(env(safe-area-inset-bottom),0px)]',
            )}
          >
            <header className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 border-b border-ink-200/60 dark:border-ink-800">
              <div className="min-w-0">
                <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
                  Why I did this
                </p>
                <h2
                  id={titleId}
                  className="mt-1 text-xl text-ink-700 dark:text-ink-50 font-semibold leading-snug truncate"
                >
                  {decision.recommendation_text || 'Decision reasoning'}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-500 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-6">
              {/* One-line "why" at the top — for users who don't want the chain */}
              <p className="text-sm text-ink-500 dark:text-ink-300 italic leading-relaxed">
                {oneLineWhy}
              </p>

              {/* Stage timeline — animated stagger reveal */}
              <ol className="mt-8 relative">
                {/* Vertical connector line behind the dots */}
                <span
                  aria-hidden="true"
                  className="absolute left-[19px] top-3 bottom-3 w-px bg-ink-200 dark:bg-ink-800"
                />
                {stages.map((s, i) => (
                  <motion.li
                    key={s.key}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.08 * (i + 1), duration: 0.32 }}
                    className="relative pl-14 pb-7 last:pb-0"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-0 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white dark:bg-ink-950 border border-ink-200/60 dark:border-ink-800 shadow-subtle"
                    >
                      <s.icon
                        className="h-4 w-4 text-accent-500"
                        aria-hidden="true"
                        strokeWidth={1.8}
                      />
                    </span>
                    <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
                      {s.label}
                    </p>
                    <div className="mt-2">{s.body}</div>
                  </motion.li>
                ))}
              </ol>
            </div>

            <footer className="px-6 sm:px-8 py-5 border-t border-ink-200/60 dark:border-ink-800 flex items-center justify-between gap-3">
              {onReplay ? (
                <button
                  type="button"
                  onClick={onReplay}
                  className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Replay decision
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-semibold bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:shadow-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
              >
                Got it
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </footer>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
