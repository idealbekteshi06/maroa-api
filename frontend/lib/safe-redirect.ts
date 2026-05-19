/**
 * lib/safe-redirect.ts
 * ---------------------------------------------------------------------------
 * Safe-redirect helper used by /auth/callback and the middleware login bounce.
 *
 * Why this exists: an open-redirect bug in the prior implementation accepted
 * any string after `?next=` and redirected the freshly-authenticated user
 * there. An attacker could send a phishing link like
 *   https://maroa.ai/auth/callback?code=valid&next=//attacker.example
 * and the browser would land on attacker-controlled HTTPS post-login.
 *
 * Allowed targets:
 *   - Relative paths starting with a single "/" followed by an alphanumeric
 *     (rules out protocol-relative `//evil.com` and `/\evil.com`)
 *   - Pathname must begin with one of ALLOWED_PREFIXES so we don't redirect
 *     into the auth flow itself (causes loops)
 *
 * Rejected:
 *   - Absolute URLs (`http://`, `https://`, `ftp://`, `data:`, `javascript:`)
 *   - Protocol-relative (`//host`)
 *   - Backslash-escaped variants (`/\evil.com`)
 *   - Anything that doesn't start with one of the allowed prefixes
 *
 * Returns the safe redirect target as a string. Falls back to DEFAULT.
 * ---------------------------------------------------------------------------
 */

export const DEFAULT_REDIRECT = '/dashboard';

const ALLOWED_PREFIXES = [
  '/dashboard',
  '/content',
  '/ads',
  '/settings',
  '/onboarding',
] as const;

/**
 * Resolve a user-supplied `next` value to a path we're willing to redirect to.
 * Defends against open-redirect by allowlisting prefixes.
 */
export function safeRedirectPath(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length === 0) return DEFAULT_REDIRECT;
  // Reject anything with a scheme or a protocol-relative URL.
  // The check looks for "//" anywhere in the string OR a colon before any
  // slash (covers javascript:, data:, http:, etc.).
  if (input.includes('//') || input.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return DEFAULT_REDIRECT;
  }
  if (!input.startsWith('/')) return DEFAULT_REDIRECT;
  // Strip query and hash for prefix matching, but keep them for the return value.
  const pathOnly = input.split(/[?#]/)[0];
  const allowed = ALLOWED_PREFIXES.some(
    (p) => pathOnly === p || pathOnly.startsWith(p + '/'),
  );
  return allowed ? input : DEFAULT_REDIRECT;
}
