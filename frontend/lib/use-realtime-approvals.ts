'use client';

import { useEffect } from 'react';
import { createBrowserClient } from '@supabase/ssr';

/**
 * lib/use-realtime-approvals.ts
 * ---------------------------------------------------------------------------
 * Multiplayer dashboard. When teammate A approves a decision in their tab,
 * teammate B sees the card fade out instantly without a refresh.
 *
 * Subscribes to Supabase realtime UPDATE events on `decision_logs` filtered
 * to rows where `approved_at` or `refused_at` just transitioned from NULL
 * to non-NULL. Calls `onResolved(decisionId, action)` on each event so the
 * calling component can drop the card from local state.
 *
 * Why Supabase realtime instead of polling: a polling dashboard shows
 * stale data for ~30s after a teammate acts. Realtime gives the Linear /
 * Notion feel — the card disappears the moment the action happens.
 *
 * No-op when Supabase env is missing (typical for first-paint SSR or
 * misconfigured local dev). Always returns clean unsubscribe.
 * ---------------------------------------------------------------------------
 */

export interface RealtimeApprovalEvent {
  decisionId: string;
  action: 'approved' | 'rejected';
  decision: Record<string, unknown>;
}

let _cachedClient: ReturnType<typeof createBrowserClient> | null = null;

function client() {
  if (_cachedClient) return _cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  _cachedClient = createBrowserClient(url, anon);
  return _cachedClient;
}

export function useRealtimeApprovals(
  workspaceId: string | null | undefined,
  onResolved: (event: RealtimeApprovalEvent) => void,
) {
  useEffect(() => {
    if (!workspaceId) return;
    const sb = client();
    if (!sb) return;

    // Supabase realtime channel per workspace. The Postgres CDC stream
    // pushes every UPDATE on decision_logs through our filter. We pick
    // out approved/refused transitions and ignore everything else (e.g.,
    // outcome_score backfills, performance attribution writes).
    const channel = sb
      .channel(`approvals:${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'decision_logs',
        },
        (payload: { new: Record<string, unknown>; old: Record<string, unknown> }) => {
          const next = payload.new || {};
          const prev = payload.old || {};

          const approved =
            !prev.approved_at && next.approved_at
              ? 'approved'
              : !prev.refused && next.refused
                ? 'rejected'
                : null;
          if (!approved) return;

          const decisionId = String(next.id || '');
          if (!decisionId) return;

          onResolved({
            decisionId,
            action: approved,
            decision: next,
          });
        },
      )
      .subscribe();

    return () => {
      sb.removeChannel(channel);
    };
  }, [workspaceId, onResolved]);
}
