'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { ArrowRight, AlertCircle, Sparkles, ShieldAlert, TrendingUp, Undo2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { DURATION, EASING_BEZIER, STATE_DOTS } from '@/lib/design-tokens';
import type { DecisionLogRow } from '@/lib/types/war-room';
import { DecisionActions } from './decision-actions';
import { OptimisticCheck } from '@/components/motion/optimistic-check';
import { useActionedDecisionIds } from '@/components/dashboard/command-palette';

const BAND_STYLES: Record<DecisionLogRow['auto_safe_band'], string> = {
  green: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300 border-green-200/60 dark:border-green-500/20',
  yellow: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200/60 dark:border-amber-500/20',
  red: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300 border-red-200/60 dark:border-red-500/20',
};

const AGENT_ICONS: Record<string, typeof Sparkles> = {
  'ad-optimizer': TrendingUp,
  'competitor-watch': AlertCircle,
  'content-generator': Sparkles,
  'agency-pipeline': Sparkles,
  cro: TrendingUp,
  voc: Sparkles,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

type ActionState = 'idle' | 'approved' | 'rejected';

const UNDO_WINDOW_MS = 7000;
const REJECT_COLLAPSED_HEIGHT = 56;

export function PriorityCard({
  decision,
  businessName,
  workspaceId,
}: {
  decision: DecisionLogRow;
  businessName?: string;
  workspaceId: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [action, setAction] = useState<ActionState>('idle');
  const [dismissed, setDismissed] = useState(false);
  // Bumping this key remounts <DecisionActions>, resetting its internal
  // state to 'pending' on undo. The HTTP call already fired so this is
  // strictly a visual revert — backend stays authoritative.
  const [actionsKey, setActionsKey] = useState(0);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Subscribe to the palette's bulk-approve actioned set so the card can
  // flip to Approved instantly when ⌘K → "Approve all green-band" fires
  // — without waiting for the server data refresh.
  const actionedIds = useActionedDecisionIds();
  useEffect(() => {
    if (action === 'idle' && actionedIds.has(decision.id)) {
      setAction('approved');
    }
  }, [actionedIds, decision.id, action]);
  const Icon = AGENT_ICONS[decision.agent_name] || Sparkles;
  const band = BAND_STYLES[decision.auto_safe_band];

  useEffect(() => {
    if (action !== 'rejected' || prefersReducedMotion) return;
    dismissTimerRef.current = setTimeout(() => setDismissed(true), UNDO_WINDOW_MS);
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [action, prefersReducedMotion]);

  function handleUndo() {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setAction('idle');
    setDismissed(false);
    setActionsKey((k) => k + 1);
  }

  // ─── Approve animation: border 4 → 12 → 4 over 880ms ────────────────────
  // Timing per spec: 220ms grow → 280ms hold → 380ms settle.
  // `times` percentages → [0, 0.25, 0.57, 1] of total 880ms.
  const borderLeftWidth =
    action === 'approved' && !prefersReducedMotion
      ? ([4, 12, 12, 4] as number[])
      : 4;
  const boxShadowKeyframes =
    action === 'approved' && !prefersReducedMotion
      ? [
          '0 0 0 0 rgba(0,113,227,0)',
          '0 0 0 4px rgba(0,113,227,0.3)',
          '0 0 0 0 rgba(0,113,227,0)',
        ]
      : action === 'rejected' && !prefersReducedMotion
      ? '0 0 0 2px rgba(255,149,0,0.12)'
      : '0 0 0 0 rgba(0,0,0,0)';

  // ─── Reject layout: collapse to short row + fade after undo window ──────
  const collapsedHeight =
    action === 'rejected'
      ? prefersReducedMotion
        ? 'auto'
        : REJECT_COLLAPSED_HEIGHT
      : 'auto';

  return (
    <m.article
      animate={{
        height: dismissed ? 0 : collapsedHeight,
        opacity: dismissed ? 0 : 1,
        marginTop: dismissed ? 0 : undefined,
        marginBottom: dismissed ? 0 : undefined,
        borderLeftWidth,
        boxShadow: boxShadowKeyframes,
      }}
      transition={{
        height: { duration: 0.24, ease: EASING_BEZIER.snappy },
        opacity: { duration: 0.3, ease: EASING_BEZIER.soft },
        borderLeftWidth: {
          duration: 0.88,
          ease: EASING_BEZIER.snappy,
          times: [0, 0.25, 0.57, 1],
        },
        boxShadow: { duration: DURATION.cinematic / 1000, ease: EASING_BEZIER.soft },
      }}
      className="overflow-hidden rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 hover:border-ink-300 dark:hover:border-ink-600 transition-colors border-l-4"
      style={{
        borderLeftColor:
          action === 'approved'
            ? STATE_DOTS.green
            : action === 'rejected'
            ? STATE_DOTS.amber
            : 'transparent',
      }}
    >
      {action === 'rejected' ? (
        <RejectedRow
          title={decision.recommendation_text}
          businessName={businessName}
          dismissed={dismissed}
          onUndo={handleUndo}
          prefersReducedMotion={!!prefersReducedMotion}
        />
      ) : (
        <div className="p-5">
          <div className="flex items-start gap-4">
            <div className={cn('h-10 w-10 rounded-xl flex items-center justify-center border', band)}>
              <Icon className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-xs font-medium uppercase tracking-wider text-ink-400">
                  {decision.agent_name.replace(/-/g, ' ')}
                </p>
                {businessName && (
                  <>
                    <span className="text-ink-300 dark:text-ink-600">·</span>
                    <p className="text-xs text-ink-400 truncate">{businessName}</p>
                  </>
                )}
                <OptimisticCheck show={action === 'approved'} />
                <span className="ml-auto text-xs text-ink-400 font-mono">{timeAgo(decision.created_at)}</span>
              </div>

              <p className="text-ink-700 dark:text-ink-100 leading-snug">
                {decision.recommendation_text}
              </p>

              {(decision.expected_upside_text || decision.risk_text) && (
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {decision.expected_upside_text && (
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-ink-400">Upside</dt>
                      <dd className="text-ink-700 dark:text-ink-200 font-medium">{decision.expected_upside_text}</dd>
                    </div>
                  )}
                  {decision.risk_text && (
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-ink-400">Risk</dt>
                      <dd className="text-ink-700 dark:text-ink-200 font-medium">{decision.risk_text}</dd>
                    </div>
                  )}
                  <div className="flex items-baseline gap-1.5">
                    <dt className="text-ink-400">Confidence</dt>
                    <dd className="text-ink-700 dark:text-ink-200 font-medium">{Math.round(decision.confidence * 100)}%</dd>
                  </div>
                  {decision.cost_usd > 0 && (
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-ink-400">Cost</dt>
                      <dd className="text-ink-700 dark:text-ink-200 font-medium">${decision.cost_usd.toFixed(2)}</dd>
                    </div>
                  )}
                </dl>
              )}

              <div className="mt-4">
                {decision.refused ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    <ShieldAlert className="h-3 w-3" />
                    Refused — {decision.refusal_reason}
                  </span>
                ) : decision.required_approval ? (
                  <DecisionActions
                    key={actionsKey}
                    workspaceId={workspaceId}
                    decisionId={decision.id}
                    detailHref="/dashboard/approvals"
                    onActionChange={setAction}
                  />
                ) : decision.executed ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Auto-executed
                  </span>
                ) : (
                  <Link
                    href="/dashboard/approvals"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400"
                  >
                    See details
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </m.article>
  );
}

/**
 * The collapsed row that replaces the full card for 7s after rejection.
 * Title gets a sweep strikethrough (decoration via an absolute overlay
 * span sized 0 → 100%); the Undo button sits at the right edge with the
 * countdown to drop-out.
 */
function RejectedRow({
  title,
  businessName,
  dismissed,
  onUndo,
  prefersReducedMotion,
}: {
  title: string;
  businessName?: string;
  dismissed: boolean;
  onUndo: () => void;
  prefersReducedMotion: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 h-full" style={{ height: REJECT_COLLAPSED_HEIGHT }}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        <span className="relative truncate text-sm text-ink-500 dark:text-ink-300">
          <span className="relative inline">
            {title}
            <m.span
              aria-hidden="true"
              className="absolute left-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
              style={{ backgroundColor: STATE_DOTS.amber }}
              initial={prefersReducedMotion ? { width: '100%' } : { width: 0 }}
              animate={{ width: '100%' }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.32, ease: EASING_BEZIER.snappy }}
            />
          </span>
        </span>
        {businessName && (
          <>
            <span className="text-ink-300 dark:text-ink-600 hidden sm:inline">·</span>
            <span className="text-xs text-ink-400 truncate hidden sm:inline">{businessName}</span>
          </>
        )}
      </div>
      <AnimatePresence>
        {!dismissed && (
          <m.button
            key="undo"
            type="button"
            onClick={onUndo}
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 border border-ink-200/60 dark:border-ink-700/60 transition-colors flex-shrink-0"
          >
            <Undo2 className="h-3 w-3" />
            Undo
          </m.button>
        )}
      </AnimatePresence>
    </div>
  );
}
