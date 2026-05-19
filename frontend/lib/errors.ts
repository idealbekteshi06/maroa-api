/**
 * lib/errors.ts
 * ---------------------------------------------------------------------------
 * Type-safe error narrowing helpers — audit 2026-05-19 F27.
 *
 * Replaces the `catch (err: any)` pattern across auth + onboarding pages.
 * `unknown` is the right type for caught values (TypeScript 4.4+), but
 * narrowing it inline at every catch is verbose. These helpers do the
 * narrowing once and surface a stable shape.
 *
 * Usage:
 *   try { ... }
 *   catch (e: unknown) {
 *     setError(errorMessage(e, 'Log-in failed. Try again.'));
 *   }
 * ---------------------------------------------------------------------------
 */

export interface ErrorLike {
  message: string;
  code?: string;
  status?: number;
}

/**
 * Extract a human-readable message from any thrown value. Handles:
 *   - Error instances (the common case)
 *   - Objects with a `.message` string
 *   - Strings
 *   - Anything else (returns the fallback)
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message || fallback;
  }
  return fallback;
}

/**
 * Narrow an unknown value to a `{ message, code?, status? }` shape if it
 * looks error-shaped. Returns null otherwise. Useful when callers need
 * the status/code to branch on, not just the message.
 */
export function asErrorLike(value: unknown): ErrorLike | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.message !== 'string') return null;
  const out: ErrorLike = { message: v.message };
  if (typeof v.code === 'string') out.code = v.code;
  if (typeof v.status === 'number') out.status = v.status;
  return out;
}

/**
 * Read a string property from a parsed JSON body without `any`-cast.
 */
export function pickString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
