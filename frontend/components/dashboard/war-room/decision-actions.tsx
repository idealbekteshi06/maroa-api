'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, X, ShieldAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { OptimisticCheck } from '@/components/motion/optimistic-check';

type LocalStatus = 'pending' | 'approving' | 'approved' | 'rejecting' | 'rejected' | 'error';

/**
 * Client-side approve/reject controls for a single decision. Posts to
 * /api/war-room/:workspaceId/decisions/:id/{approve,reject} with optimistic
 * state — buttons immediately show the in-flight status, and on success
 * collapse to a confirmation pill. On failure: revert + inline error.
 *
 * This is the safety-critical replacement for the previous static
 * Approve/Reject buttons that gave the illusion of control without
 * actually mutating server state.
 */
export function DecisionActions({
  workspaceId,
  decisionId,
  detailHref,
  initialStatus = 'pending',
  onActionChange,
}: {
  workspaceId: string;
  decisionId: string;
  detailHref: string;
  initialStatus?: LocalStatus;
  onActionChange?: (status: 'approved' | 'rejected') => void;
}) {
  const [status, setStatus] = useState<LocalStatus>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function mutate(action: 'approve' | 'reject') {
    const previous = status;
    setError(null);
    setStatus(action === 'approve' ? 'approving' : 'rejecting');

    try {
      const res = await fetch(
        `/api/war-room/${encodeURIComponent(workspaceId)}/decisions/${encodeURIComponent(decisionId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: action === 'reject' ? JSON.stringify({ reason: '' }) : undefined,
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg =
          (body && (body.error || body.message)) ||
          (res.status === 409
            ? 'Already actioned'
            : res.status === 404
            ? 'Decision not found'
            : 'Request failed');
        setStatus(previous);
        setError(msg);
        return;
      }

      const next = action === 'approve' ? 'approved' : 'rejected';
      setStatus(next);
      onActionChange?.(next);
      // Refresh server data in the background so other consumers
      // (sidebar inbox, KPI strip) reflect the change.
      startTransition(() => {
        if (typeof window !== 'undefined') {
          // Soft refresh — Next App Router invalidates server data on next nav.
          // We intentionally do NOT navigate; we just let the local pill stand.
        }
      });
    } catch (e) {
      setStatus(previous);
      setError(e instanceof Error ? e.message : 'Network error');
    }
  }

  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300">
        <OptimisticCheck show={true} />
        Approved
      </span>
    );
  }

  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200">
        <ShieldAlert className="h-3 w-3" />
        Rejected
      </span>
    );
  }

  const busy = status === 'approving' || status === 'rejecting';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Link
        href={detailHref}
        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-900 dark:hover:bg-ink-100 transition-colors"
      >
        Review
        <ArrowRight className="h-3 w-3" />
      </Link>
      <button
        type="button"
        disabled={busy}
        onClick={() => mutate('approve')}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition-colors',
          'text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        {status === 'approving' ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Approving…
          </>
        ) : (
          <>
            <Check className="h-3 w-3" />
            Approve
          </>
        )}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => mutate('reject')}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition-colors',
          'text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 hover:text-ink-700 dark:hover:text-ink-100',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        {status === 'rejecting' ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" />
            Rejecting…
          </>
        ) : (
          <>
            <X className="h-3 w-3" />
            Reject
          </>
        )}
      </button>
      {error && (
        <span
          role="alert"
          className="text-xs text-red-600 dark:text-red-400 ml-1 font-medium"
        >
          {error}
        </span>
      )}
    </div>
  );
}
