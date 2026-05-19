import { api } from './client';

/**
 * lib/api/billing.ts
 * ---------------------------------------------------------------------------
 * Plans + checkout endpoints.
 *   - GET  /api/billing/plans  → public catalog
 *   - POST /api/checkout       → Paddle session
 * ---------------------------------------------------------------------------
 */

export interface PlanTier {
  price: number;
  price_label?: string;
  features: string[];
  highlighted?: boolean;
}

export interface PlanCatalog {
  starter?: PlanTier;
  growth?: PlanTier;
  agency?: PlanTier;
  enterprise?: PlanTier;
}

export interface CheckoutResponse {
  checkout_id: string;
  url: string;
}

export async function fetchPlans(): Promise<PlanCatalog | null> {
  try {
    const r = await api.get<{ plans: PlanCatalog }>('/api/billing/plans');
    return r.plans || null;
  } catch {
    return null;
  }
}

export async function startCheckout(
  userId: string,
  plan: 'growth' | 'agency',
  successUrl?: string,
): Promise<CheckoutResponse | null> {
  try {
    return await api.post<CheckoutResponse>('/api/checkout', {
      user_id: userId,
      plan,
      success_url: successUrl,
    });
  } catch {
    return null;
  }
}
