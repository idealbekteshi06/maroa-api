import 'server-only';

/**
 * lib/api/plans.server.ts
 * ---------------------------------------------------------------------------
 * Server-component fetch for the public plan catalog.
 *
 *   GET /api/billing/plans  (server.js → lib/planCatalog.js)
 *
 * The catalog is the single source of truth for price + feature lists, so
 * the marketing pricing page and the in-app plan panel can't drift from the
 * backend's actual gating. Public endpoint — no auth needed.
 *
 * Returns null on failure so callers fall back to their static scaffold.
 * ---------------------------------------------------------------------------
 */
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export interface RawPlanTier {
  name?: string;
  price?: number;
  annual?: number;
  features?: string[];
  [key: string]: unknown;
}

export interface RawPlanCatalog {
  starter?: RawPlanTier;
  growth?: RawPlanTier;
  agency?: RawPlanTier;
}

export async function fetchPlansSSR(): Promise<RawPlanCatalog | null> {
  const url = `${API_URL.replace(/\/$/, '')}/api/billing/plans`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      // Public, slow-changing data — cache for 5 minutes.
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { plans?: RawPlanCatalog };
    return json.plans ?? null;
  } catch {
    return null;
  }
}
