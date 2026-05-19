import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { safeRedirectPath } from '@/lib/safe-redirect';

/**
 * /auth/callback — Magic-link landing route.
 *
 * Supabase sends users back here with a `code` query param. We exchange it
 * for a session and redirect to the original destination (or /dashboard).
 *
 * COOKIE HANDLING (was broken pre-2026-05-16):
 *   The Supabase SSR client needs to write session cookies on the OUTGOING
 *   response so the browser persists them. The previous implementation
 *   wrote to `request.cookies.set(...)` which had no effect — every
 *   magic-link visit silently failed to persist the session.
 *
 *   Correct pattern: construct the NextResponse first, hand Supabase a
 *   `setAll` that writes to `response.cookies`, then return that response.
 *
 * OPEN-REDIRECT FIX (audit 2026-05-19 F1):
 *   The `next` param is allowlisted via lib/safe-redirect — anything not
 *   matching /(dashboard|content|ads|settings|onboarding) is dropped to
 *   /dashboard so we can't be used as a phishing redirector.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeRedirectPath(searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  // Construct the response we'll return so we can write cookies to it.
  const response = NextResponse.redirect(`${origin}${next}`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set({
              name,
              value,
              ...options,
              sameSite: options?.sameSite ?? 'lax',
              secure: options?.secure ?? process.env.NODE_ENV === 'production',
              httpOnly: options?.httpOnly ?? true,
              path: options?.path ?? '/',
            });
          });
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  return response;
}
