/**
 * lib/api/index.ts — typed API surface for the Maroa backend.
 *
 * Wraps the most-used backend endpoints. Each function uses `apiFetch`
 * under the hood so it automatically gets the user's Supabase JWT.
 *
 * Audit 2026-05-20: prior versions exported `businesses`, `content`, `ads`
 * namespaces wrapping endpoints that don't exist on the backend. Frontend
 * components were silently importing 404-traps. Trimmed to only the
 * endpoints that have verified backend handlers.
 */

import { api } from './client';

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
    websiteUrl?: string;
  }) =>
    api.post<{
      ok: boolean;
      businessId: string;
      profile: { id: string; business_name: string; industry: string; location: string };
      nextStep: 'spark';
    }>('/api/onboarding/save', input),
  // POST /api/onboarding/spark — synchronously kicks off the first content
  // draft via the closed-loop creative engine. Returns the draft inline if
  // it completes in <30s; otherwise the dashboard polls for it.
  spark: () =>
    api.post<{
      ok: boolean;
      businessId: string;
      draftReady: boolean;
      draft?: unknown;
      message?: string;
    }>('/api/onboarding/spark', {}),
};

export const oauth = {
  // Production endpoints are /webhook/oauth/{meta,google}/start?businessId=...
  // — the JWT-protected handlers live in services/oauth/{meta,google}.js.
  connectMeta: (businessId: string) => {
    window.location.href = `/webhook/oauth/meta/start?businessId=${encodeURIComponent(businessId)}`;
  },
  connectGoogle: (businessId: string) => {
    window.location.href = `/webhook/oauth/google/start?businessId=${encodeURIComponent(businessId)}`;
  },
};

export const agency = {
  generate: (input: { surface: string; goal: string; awareness?: string; funnel?: string; trace?: boolean }) => {
    const qs = input.trace ? '?trace=1' : '';
    return api.post<{ output: string; reasoning_trace?: unknown }>(`/webhook/agency-generate${qs}`, input);
  },
};
