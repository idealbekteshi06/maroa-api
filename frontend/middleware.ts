import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
    },
  );

  // Refresh session (Supabase auto-rotates tokens nearing expiry).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Auth gate
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (isProtected && !user) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname + (search || ''));
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
