import { api } from './client';

/**
 * lib/api/business.ts
 * ---------------------------------------------------------------------------
 * Brand voice + onboarding profile endpoints.
 *   - GET    /api/business/:id/brand-voice
 *   - POST   /api/onboarding/save
 *   - GET    /api/onboarding/profile/:userId
 *   - PATCH  /api/onboarding/profile/:userId
 *   - GET    /api/onboarding/score/:userId
 * ---------------------------------------------------------------------------
 */

export interface BrandVoice {
  tone: string;
  do_use: string[];
  do_not_use: string[];
  customer_phrases: string[];
  updated_at?: string | null;
  confidence?: number | null;
  derived_from?: string | null;
}

export interface OnboardingProfile {
  business_name?: string;
  industry?: string;
  location?: string;
  region?: string;
  audience?: string;
  goal?: string;
  brand_tone?: string;
  voice_seed?: string;
  [key: string]: unknown;
}

export interface OnboardingScore {
  score: number;
  missing_fields: string[];
  recommendations: string[];
}

export async function fetchBrandVoice(businessId: string): Promise<BrandVoice | null> {
  try {
    const r = await api.get<{ voice: BrandVoice }>(
      `/api/business/${encodeURIComponent(businessId)}/brand-voice`,
    );
    return r.voice || null;
  } catch {
    return null;
  }
}

export async function fetchOnboardingProfile(userId: string): Promise<OnboardingProfile | null> {
  try {
    const r = await api.get<{ profile: OnboardingProfile }>(
      `/api/onboarding/profile/${encodeURIComponent(userId)}`,
    );
    return r.profile || null;
  } catch {
    return null;
  }
}

export async function updateOnboardingProfile(
  userId: string,
  patch: Partial<OnboardingProfile>,
): Promise<OnboardingProfile | null> {
  try {
    const r = await api.patch<{ profile: OnboardingProfile }>(
      `/api/onboarding/profile/${encodeURIComponent(userId)}`,
      patch,
    );
    return r.profile || null;
  } catch {
    return null;
  }
}

export async function fetchOnboardingScore(userId: string): Promise<OnboardingScore | null> {
  try {
    return await api.get<OnboardingScore>(
      `/api/onboarding/score/${encodeURIComponent(userId)}`,
    );
  } catch {
    return null;
  }
}
