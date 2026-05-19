import { api } from './client';

/**
 * lib/api/ideas.ts
 * ---------------------------------------------------------------------------
 * Marketing ideas + lead magnets + launch plans endpoints. Each follows
 * the same fire-and-forget pattern: POST /generate returns 202 quickly,
 * then the UI polls GET /:userId for results.
 * ---------------------------------------------------------------------------
 */

export interface Idea {
  id?: string;
  idea: string;
  category?: string;
  priority?: string;
  estimated_impact?: string;
  how_to_execute?: string;
  budget_required?: string;
  time_to_results?: string;
  status?: string;
  created_at?: string;
}

export interface LeadMagnet {
  id?: string;
  title: string;
  type?: string;
  content?: unknown;
  is_active?: boolean;
  created_at?: string;
}

export interface LaunchCampaign {
  id?: string;
  product_name: string;
  launch_date?: string;
  phase?: string;
  content_plan?: unknown;
  created_at?: string;
}

export async function listIdeas(userId: string): Promise<Idea[]> {
  try {
    const r = await api.get<{ ideas: Idea[] }>(`/api/ideas/${encodeURIComponent(userId)}`);
    return r.ideas || [];
  } catch {
    return [];
  }
}

export async function generateIdeas(userId: string): Promise<{ received: boolean }> {
  try {
    return await api.post<{ received: boolean }>('/api/ideas/generate', { userId });
  } catch {
    return { received: false };
  }
}

export async function listLeadMagnets(userId: string): Promise<LeadMagnet[]> {
  try {
    const r = await api.get<{ magnets: LeadMagnet[] }>(
      `/api/lead-magnets/${encodeURIComponent(userId)}`,
    );
    return r.magnets || [];
  } catch {
    return [];
  }
}

export async function generateLeadMagnet(userId: string): Promise<{ received: boolean }> {
  try {
    return await api.post<{ received: boolean }>('/api/lead-magnets/generate', { userId });
  } catch {
    return { received: false };
  }
}

export async function listLaunchCampaigns(userId: string): Promise<LaunchCampaign[]> {
  try {
    const r = await api.get<{ campaigns: LaunchCampaign[] }>(
      `/api/launch/${encodeURIComponent(userId)}`,
    );
    return r.campaigns || [];
  } catch {
    return [];
  }
}
