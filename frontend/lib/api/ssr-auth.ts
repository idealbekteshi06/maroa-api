import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

/**
 * lib/api/ssr-auth.ts
 * ---------------------------------------------------------------------------
 * Shared helper for server components that need the signed-in user's
 * Supabase access token to call the backend with `Authorization: Bearer`.
 *
 * Mirrors the cookie→token reader in war-room.server.ts. Kept as its own
 * module so new authenticated SSR fetches (integrations, etc.) don't each
 * re-implement it. `server-only` so it can never be bundled into the client.
 * ---------------------------------------------------------------------------
 */
export async function getServerAccessToken(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const cookieStore = await cookies();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // Server reads only — never mutate cookies from this path.
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // intentionally a no-op
      },
    },
  });
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
