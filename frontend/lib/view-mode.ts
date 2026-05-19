/**
 * lib/view-mode.ts
 * ---------------------------------------------------------------------------
 * Dashboard view mode — "calm" (the new default, for SMB owners) vs "pro"
 * (the dense War Room, for freelancers/agencies running many clients).
 *
 * Stored in a cookie so the server component knows which view to render
 * on the first paint — no flicker, no useEffect swap.
 *
 * Onboarding writes this cookie based on the user's answer to "Is this
 * for your business, or are you running it for clients?". The sidebar
 * surfaces a toggle so the user can flip themselves.
 *
 * Cookie name: `maroa.view`. Values: `calm` | `pro`. TTL: 1 year.
 * httpOnly is FALSE — the client component needs to read it for the
 * toggle's optimistic UI. This isn't sensitive data so client read access
 * is safe.
 * ---------------------------------------------------------------------------
 */

export type ViewMode = 'calm' | 'pro';

export const VIEW_MODE_COOKIE = 'maroa.view';
export const DEFAULT_VIEW_MODE: ViewMode = 'calm';

export function parseViewMode(value: string | null | undefined): ViewMode {
  return value === 'pro' ? 'pro' : 'calm';
}

/**
 * Read the cookie from a Server Component context.
 *
 * NOTE: we don't import `next/headers` here because that would taint this
 * module as server-only. Callers in Server Components do:
 *
 *   import { cookies } from 'next/headers';
 *   import { parseViewMode, VIEW_MODE_COOKIE } from '@/lib/view-mode';
 *   const c = await cookies();
 *   const mode = parseViewMode(c.get(VIEW_MODE_COOKIE)?.value);
 *
 * Client components read via `document.cookie` (see view-mode-toggle.tsx).
 */

export function readViewModeFromCookieString(cookieHeader: string | null | undefined): ViewMode {
  if (!cookieHeader) return DEFAULT_VIEW_MODE;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${VIEW_MODE_COOKIE}=`)) {
      return parseViewMode(decodeURIComponent(part.slice(VIEW_MODE_COOKIE.length + 1)));
    }
  }
  return DEFAULT_VIEW_MODE;
}
