import { api } from './client';

/**
 * lib/api/workspaces.ts
 * ---------------------------------------------------------------------------
 * Typed wrappers around the workspace + membership + client endpoints
 * defined in routes/workspaces.js. Used by the Clients page and the
 * agency-mode Team settings.
 * ---------------------------------------------------------------------------
 */

export type WorkspaceRole = 'owner' | 'strategist' | 'designer' | 'viewer';
export type PlanTier = 'solo' | 'freelancer' | 'agency' | 'enterprise';

export interface Workspace {
  id: string;
  name: string;
  plan_tier: PlanTier;
  role?: WorkspaceRole;
  created_at: string;
  branding?: Record<string, unknown> | null;
}

export interface WorkspaceMember {
  user_id: string;
  email: string;
  role: WorkspaceRole;
  invited_at?: string | null;
  joined_at?: string | null;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invited_at: string;
  expires_at: string;
}

export interface ClientRow {
  business_id: string;
  client_name?: string | null;
  monthly_retainer_usd?: number | null;
  status: string;
  added_at?: string | null;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  try {
    const r = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
    return r.workspaces || [];
  } catch {
    return [];
  }
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  try {
    const r = await api.get<{ members: WorkspaceMember[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    return r.members || [];
  } catch {
    return [];
  }
}

export async function listClients(workspaceId: string): Promise<ClientRow[]> {
  try {
    const r = await api.get<{ clients: ClientRow[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/clients`,
    );
    return r.clients || [];
  } catch {
    return [];
  }
}

export async function inviteMember(
  workspaceId: string,
  email: string,
  role: WorkspaceRole = 'viewer',
): Promise<WorkspaceInvite | null> {
  try {
    const r = await api.post<{ invite: WorkspaceInvite }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
      { email, role },
    );
    return r.invite;
  } catch {
    return null;
  }
}
