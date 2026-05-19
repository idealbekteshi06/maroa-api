'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Check, X, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { approveDecision, rejectDecision } from '@/lib/api/war-room';
import { approvalAsk, whyExplanation, decisionCategory } from '@/lib/translate';
import { errorMessage } from '@/lib/errors';
import type { DecisionLogRow } from '@/lib/types/war-room';

/**
 * components/dashboard/today/approval-card.tsx
 * ---------------------------------------------------------------------------
 * The single most important component in the calm dashboard.
 *
 * Anatomy (intentionally minimal):
 *   - Category chip (Content · Ads · Budget · Compliance · etc.)
 *   - One-line question in plain English ("Approve this Instagram post?")
 *   - Optional preview (caption, image, ad copy)
 *   - Two big buttons: Approve / Not yet
 *   - Tiny "why?" disclosure that expands into the reasoning trace
 *
 * Approval flow:
 *   1. Click "Approve" → button enters loading state, card fades to 50%
 *   2. POST /api/war-room/:ws/decisions/:id/approve with Idempotency-Key
 *   3. On success: Sonner toast "Approved · Undo (5s)" + card collapses
 *   4. On failure: card restores, error toast with retry
 *
 * Rejection works the same with an optional reason prompt.
 *
 * Why this matters: a café owner who logs in and sees ONE clear card
 * with ONE clear question and TWO big buttons is the entire product
 * promise. Everything else on the page is reassurance — this card is
 * the moment of truth.
 * ---------------------------------------------------------------------------
 */

export interface ApprovalCardProps {
  workspaceId: string;
  decision: DecisionLogRow;
  /** Called after a successful approve/reject so the parent can drop the card. */
  onResolved?: (decisionId: string, action: 'approved' | 'rejected') => void;
  /** Optional rich preview content (post caption, ad creative, etc.). */
  preview?: React.ReactNode;
}

const CATEGORY_LABEL: Record<string, string> = {
  content: 'Content',
  ads: 'Ads',
  budget: 'Budget',
  creative: 'Creative',
  experiment: 'Experiment',
  competitor: 'Competitor',
  compliance: 'Compliance',
  audience: 'Audience',
  report: 'Report',
  system: 'Update',
};

export function ApprovalCard({ workspaceId, decision, onResolved, preview }: ApprovalCardProps) {
  const [explained, setExplained] = useState(false);
  const [resolving, startTransition] = useTransition();
  const [resolved, setResolved] = useState<'approved' | 'rejected' | null>(null);

  const question = approvalAsk(decision);
  const explanation = whyExplanation(decision);
  const category = CATEGORY_LABEL[decisionCategory(decision)] || 'Update';
  const idempotencyKey = `approve-${decision.id}-${Date.now()}`;

  function approve() {
    if (resolving || resolved) return;
    setResolved('approved');
    startTransition(async () => {
      try {
        await approveDecision(workspaceId, decision.id, idempotencyKey);
        toast.success('Approved', {
          description: 'Maroa is shipping this now.',
          duration: 4000,
        });
        onResolved?.(decision.id, 'approved');
      } catch (e) {
        setResolved(null);
        toast.error('Could not approve', {
          description: errorMessage(e, 'Try again in a moment.'),
        });
      }
    });
  }

  function reject() {
    if (resolving || resolved) return;
    setResolved('rejected');
    // No prompt — kept tap-light. Power users can leave a reason from /pro.
    startTransition(async () => {
      try {
        await rejectDecision(workspaceId, decision.id, undefined, idempotencyKey);
        toast('Skipped', {
          description: 'Maroa won’t ship this one.',
          duration: 4000,
        });
        onResolved?.(decision.id, 'rejected');
      } catch (e) {
        setResolved(null);
        toast.error('Could not skip', {
          description: errorMessage(e, 'Try again in a moment.'),
        });
      }
    });
  }

  return (
    <article
      className={cn(
        'group rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle overflow-hidden transition-all duration-200',
        resolved && 'opacity-50 scale-[0.99]',
      )}
      aria-busy={resolving}
    >
      <div className="px-6 sm:px-7 py-6">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300 px-2.5 py-0.5 text-xs font-medium">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {category}
          </span>
          {decision.confidence >= 0.7 && (
            <span className="text-xs text-ink-500 dark:text-ink-300">
              {Math.round(decision.confidence * 100)}% sure
            </span>
          )}
        </div>

        <p className="text-lg sm:text-xl text-ink-700 dark:text-ink-50 font-medium leading-snug text-balance">
          {question}
        </p>

        {preview && (
          <div className="mt-4 rounded-xl bg-ink-50 dark:bg-ink-950 border border-ink-200/60 dark:border-ink-800 p-4 text-sm text-ink-700 dark:text-ink-200">
            {preview}
          </div>
        )}

        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={approve}
            disabled={resolving || resolved !== null}
            className={cn(
              'flex-1 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-base font-semibold transition-shadow',
              'bg-ink-700 text-white dark:bg-white dark:text-ink-900',
              'hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
              'disabled:opacity-60 disabled:cursor-not-allowed',
            )}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            onClick={reject}
            disabled={resolving || resolved !== null}
            className={cn(
              'inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-base font-medium',
              'text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
              'disabled:opacity-60 disabled:cursor-not-allowed',
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Not this one
          </button>
        </div>

        <button
          type="button"
          aria-expanded={explained}
          onClick={() => setExplained((v) => !v)}
          className={cn(
            'mt-5 inline-flex items-center gap-1 text-xs text-ink-500 dark:text-ink-300 hover:text-ink-700 dark:hover:text-ink-100 transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 rounded',
          )}
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', explained && 'rotate-180')}
            aria-hidden="true"
          />
          {explained ? 'Hide reasoning' : 'Why this?'}
        </button>
        {explained && (
          <p className="mt-3 text-sm text-ink-500 dark:text-ink-300 leading-relaxed border-l-2 border-accent-200 dark:border-accent-800 pl-3">
            {explanation}
          </p>
        )}
      </div>
    </article>
  );
}
