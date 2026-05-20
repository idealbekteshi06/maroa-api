/**
 * lib/api/index.ts — typed API surface for the Maroa backend.
 *
 * Wraps the most-used backend endpoints. Each function uses `apiFetch`
 * under the hood so it automatically gets the user's Supabase JWT.
 */

import { api } from './client';

// ── Types matching the backend's response shapes ──────────────────────

export type Business = {
  id: string;
  business_name: string;
  industry: string;
  region: string;
  plan: 'free' | 'growth' | 'agency';
  created_at: string;
};

export type GeneratedContent = {
  id: string;
  business_id: string;
  status: 'draft' | 'scheduled' | 'published' | 'rejected';
  scheduled_at: string | null;
  published_at: string | null;
  instagram_caption?: string;
  facebook_post?: string;
  linkedin_post?: string;
  email_subject?: string;
  email_body?: string;
  blog_title?: string;
  image_url?: string;
  content_theme?: string;
  performance_score?: number;
  reasoning_trace?: unknown;
};

export type Campaign = {
  id: string;
  business_id: string;
  platform: 'meta' | 'google' | 'tiktok';
  status: 'active' | 'paused' | 'review';
  daily_budget_usd: number;
  spend_today: number;
  roas_7d?: number;
  audit_verdict?: 'scale' | 'maintain' | 'pause' | 'rework';
  audit_reason?: string;
};

// ── API ───────────────────────────────────────────────────────────────

export const businesses = {
  me: () => api.get<Business>('/api/businesses/me'),
  update: (patch: Partial<Business>) => api.patch<Business>('/api/businesses/me', patch),
};

export const content = {
  list: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    return api.get<GeneratedContent[]>(`/api/content${qs.toString() ? `?${qs}` : ''}`);
  },
  get: (id: string) => api.get<GeneratedContent>(`/api/content/${id}`),
  approve: (id: string) => api.post<GeneratedContent>(`/api/content/${id}/approve`),
  reject: (id: string, reason?: string) =>
    api.post<GeneratedContent>(`/api/content/${id}/reject`, { reason }),
  regenerate: (id: string) => api.post<GeneratedContent>(`/api/content/${id}/regenerate`),
  schedule: (id: string, at: string) => api.post<GeneratedContent>(`/api/content/${id}/schedule`, { at }),
};

export const ads = {
  campaigns: () => api.get<Campaign[]>('/api/ads/campaigns'),
  audit: (id: string) => api.get<Campaign>(`/api/ads/campaigns/${id}/audit`),
  applyRecommendation: (id: string) => api.post<Campaign>(`/api/ads/campaigns/${id}/apply`),
};

export const onboarding = {
  // POST /api/onboarding/save — fast, idempotent upsert of the business
  // profile. Returns immediately so the dashboard can show its loading
  // animation while spark runs.
  start: (input: {
    businessName: string;
    industry: string;
    region: string;
    goal?: string;
    audience?: string;
    voiceSeed?: string;
  }) =>
    api.post<{
      ok: boolean;
      businessId: string;
      profile: { id: string; business_name: string; industry: string; location: string };
      nextStep: 'spark';
    }>('/api/onboarding/save', input),
  // POST /api/onboarding/spark — synchronously kicks off the first content
  // draft via /api/content/generate. Returns the draft inline if it
  // completes in <30s; otherwise the dashboard polls for it.
  spark: () =>
    api.post<{
      ok: boolean;
      businessId: string;
      draftReady: boolean;
      draft?: unknown;
      message?: string;
    }>('/api/onboarding/spark', {}),
  status: (runId: string) =>
    api.get<{ status: string; phase: string; progress: number }>(`/api/onboarding/${runId}`),
};

export const oauth = {
  connectMeta: () => {
    window.location.href = '/api/oauth/meta/start';
  },
  connectGoogle: () => {
    window.location.href = '/api/oauth/google/start';
  },
};

export const agency = {
  generate: (input: { surface: string; goal: string; awareness?: string; funnel?: string; trace?: boolean }) => {
    const qs = input.trace ? '?trace=1' : '';
    return api.post<{ output: string; reasoning_trace?: unknown }>(`/webhook/agency-generate${qs}`, input);
  },
};
