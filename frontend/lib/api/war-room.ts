import { api, ApiError } from './client';
import type { DecisionLogRow, WorkspaceFeed } from '@/lib/types/war-room';

type WorkspaceListItem = {
  id: string;
  name: string;
  plan_tier: WorkspaceFeed['workspace']['plan_tier'];
};

/**
 * Resolve the active workspace + feed for the signed-in caller.
 *
 *   1. GET /api/workspaces — list memberships.
 *   2. Pick the first (server already returns by recency).
 *   3. GET /api/war-room/:workspaceId — the actual feed.
 *
 * Returns `null` for any of:
 *   - no session / 401
 *   - caller has no workspace (new user before workspace creation)
 *   - backend down / network failure
 *
 * Callers fall back to mock data on `null` so the UI never shows blank.
 */
export async function fetchActiveWorkspaceFeed(): Promise<WorkspaceFeed | null> {
  try {
    const list = await api.get<{ workspaces: WorkspaceListItem[] }>('/api/workspaces');
    const first = list?.workspaces?.[0];
    if (!first?.id) return null;
    const feed = await api.get<WorkspaceFeed>(`/api/war-room/${encodeURIComponent(first.id)}`);
    return feed && feed.workspace ? feed : null;
  } catch (err) {
    if (err instanceof ApiError) {
      // 401/403/404 + 5xx all degrade silently to the mock. The dashboard
      // banner will tell the user the data is illustrative.
      return null;
    }
    return null;
  }
}

interface ApproveResponse {
  ok: boolean;
  decision?: DecisionLogRow;
  already_approved?: boolean;
}

interface RejectResponse {
  ok: boolean;
  decision?: DecisionLogRow;
  already_approved?: boolean;
}

/**
 * Approve a pending decision. Maps to:
 *   POST /api/war-room/:workspaceId/decisions/:decisionId/approve
 *
 * The backend is idempotent — already-approved decisions return 200 with
 * the row. Caller can therefore optimistically remove the card from UI
 * before the network promise resolves; a failed call is reverted with a
 * Sonner error toast.
 */
export async function approveDecision(
  workspaceId: string,
  decisionId: string,
  // Idempotency-Key prevents the same approve from double-firing on a
  // browser retry. Caller passes a stable key per click (e.g., random UUID).
  idempotencyKey?: string,
): Promise<ApproveResponse> {
  return api.post<ApproveResponse>(
    `/api/war-room/${encodeURIComponent(workspaceId)}/decisions/${encodeURIComponent(decisionId)}/approve`,
    {},
    idempotencyKey
      ? { headers: { 'Idempotency-Key': idempotencyKey } }
      : undefined,
  );
}

/**
 * Reject a pending decision with an optional one-line reason. Maps to:
 *   POST /api/war-room/:workspaceId/decisions/:decisionId/reject
 */
export async function rejectDecision(
  workspaceId: string,
  decisionId: string,
  reason?: string,
  idempotencyKey?: string,
): Promise<RejectResponse> {
  return api.post<RejectResponse>(
    `/api/war-room/${encodeURIComponent(workspaceId)}/decisions/${encodeURIComponent(decisionId)}/reject`,
    { reason: reason || null },
    idempotencyKey
      ? { headers: { 'Idempotency-Key': idempotencyKey } }
      : undefined,
  );
}
