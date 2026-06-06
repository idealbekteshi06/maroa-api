import 'server-only';
import { getServerAccessToken } from './ssr-auth';

/**
 * lib/api/integrations.server.ts
 * ---------------------------------------------------------------------------
 * Server-component fetch for per-business integration health.
 *
 *   GET /api/business/:businessId/integrations  (server.js)
 *
 * Returns live connection state for Meta, Google, LinkedIn, email, etc.
 * Used by the Connections settings page + the Settings hub so the status
 * pills reflect reality instead of a hard-coded "Not connected".
 *
 * Returns null on any failure (no session, business not found, backend
 * down) so callers degrade gracefully to "not connected".
 * ---------------------------------------------------------------------------
 */
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export interface IntegrationHealthItem {
  key: string;
  label: string;
  connected: boolean;
  status: 'healthy' | 'degraded' | 'disconnected' | string;
  detail?: string | null;
  last_sync_at?: string | null;
  expires_at?: string | null;
  last_error?: string | null;
}

export interface IntegrationsHealth {
  ok: boolean;
  business_id: string;
  business_name?: string;
  plan?: string;
  integrations: IntegrationHealthItem[];
  connected_count: number;
  recommended_action?: string | null;
}

export async function fetchIntegrationsSSR(businessId: string): Promise<IntegrationsHealth | null> {
  const token = await getServerAccessToken();
  if (!token) return null;
  const url = `${API_URL.replace(/\/$/, '')}/api/business/${encodeURIComponent(businessId)}/integrations`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as IntegrationsHealth;
    return json && json.ok ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
