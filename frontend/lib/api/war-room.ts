import { api, ApiError } from './client';
import type { WorkspaceFeed } from '@/lib/types/war-room';

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
