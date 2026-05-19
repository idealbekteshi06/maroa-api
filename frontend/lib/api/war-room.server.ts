import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { WorkspaceFeed } from '@/lib/types/war-room';

/**
 * lib/api/war-room.server.ts
 * ---------------------------------------------------------------------------
 * Server-component variant of fetchActiveWorkspaceFeed.
 *
 * Audit 2026-05-19 F12: the client useEffect chain (list workspaces → fetch
 * feed) caused a visible mock→real reflow on every dashboard load. Moving
 * the fetch to the server component:
 *   - First paint already has real data (no flicker, no shift)
 *   - Only one round-trip to the API per route render
 *   - Auth token is read from the request cookies via Supabase SSR — no
 *     "Authorization not set yet" race on the very first render
 *
 * Returns null on any failure so callers fall back to the bundled mock and
 * the dashboard never shows blank.
 *
 * Tagged `import 'server-only'` so accidental imports from a client
 * component fail loudly at build time instead of bundling the SUPABASE
 * credentials into the browser.
 * ---------------------------------------------------------------------------
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

interface WorkspaceListItem {
  id: string;
  name: string;
  plan_tier: WorkspaceFeed['workspace']['plan_tier'];
}

async function getAccessToken(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const cookieStore = await cookies();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // Server-side reads only — we don't mutate cookies from this path.
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // intentionally a no-op
      },
    },
  });
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function getJson<T>(path: string, token: string): Promise<T | null> {
  const url = `${API_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchActiveWorkspaceFeedSSR(): Promise<WorkspaceFeed | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const list = await getJson<{ workspaces: WorkspaceListItem[] }>('/api/workspaces', token);
  const first = list?.workspaces?.[0];
  if (!first?.id) return null;
  const feed = await getJson<WorkspaceFeed>(
    `/api/war-room/${encodeURIComponent(first.id)}`,
    token,
  );
  return feed && feed.workspace ? feed : null;
}
