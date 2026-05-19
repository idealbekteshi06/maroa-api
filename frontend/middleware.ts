import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { safeRedirectPath } from '@/lib/safe-redirect';

/**
 * middleware.ts — auth gate + session refresh.
 *
 * Runs on every request matched by `config.matcher` below. Two jobs:
 *
 *   1. Refresh the Supabase session on every request so the JWT in cookies
 *      stays fresh. Without this, long-idle tabs hit expired tokens and
 *      every /api/* call fails until full re-login.
 *
 *   2. Gate the dashboard. Any unauthenticated visit to /dashboard /content
 *      /ads /settings /onboarding redirects to /login with the original
 *      destination preserved in the `?next=` query so post-login can
 *      bounce back.
 *
 * The Supabase SSR client requires both `getAll` (read incoming cookies)
 * and `setAll` (write to the outgoing response). Matches the corrected
 * pattern in app/auth/callback/route.ts.
 */

const PROTECTED_PREFIXES = ['/dashboard', '/content', '/ads', '/settings', '/onboarding'];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // Construct the response we'll mutate cookies on.
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Graceful degrade: if Supabase env is missing (typical for a fresh
  // local checkout before .env is filled in), don't throw — let the
  // request through unauthenticated and let the page-level auth UI
  // handle it. The previous behaviour was a 500 with a non-null assertion
  // crash on first paint.
  if (!supabaseUrl || !supabaseAnonKey) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        '[middleware] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY missing — auth gate disabled.',
      );
    }
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Reset response so we can re-emit fresh cookies + headers
        response = NextResponse.next({ request });
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
  });

  // Refresh session (Supabase auto-rotates tokens nearing expiry).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Auth gate
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (isProtected && !user) {
    const loginUrl = new URL('/login', request.url);
    // Pass `next` only if it's in the safelist — defeats any chained
    // open-redirect (audit 2026-05-19 F2). The callback route will
    // re-validate anyway, but defense in depth.
    const safeNext = safeRedirectPath(pathname + (search || ''));
    if (safeNext !== '/dashboard' || pathname.startsWith('/dashboard')) {
      loginUrl.searchParams.set('next', safeNext);
    }
    return NextResponse.redirect(loginUrl);
  }

  // If a signed-in user hits /login or /signup, send them to the dashboard
  // — no point showing the form.
  if (user && (pathname === '/login' || pathname === '/signup')) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return response;
}

export const config = {
  // Run on everything EXCEPT static files + Next internals + API routes.
  matcher: [
    /*
     * Match all paths except:
     *   - _next/static (assets)
     *   - _next/image (image optimization)
     *   - favicon, sitemap, robots, manifest, og-image
     *   - any path with a file extension (jpg, png, svg, ico, json, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.json|opengraph-image|apple-touch-icon|icon-).*)',
  ],
};
