'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Layers } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  DEFAULT_VIEW_MODE,
  VIEW_MODE_COOKIE,
  parseViewMode,
  type ViewMode,
} from '@/lib/view-mode';

/**
 * components/dashboard/view-mode-toggle.tsx
 * ---------------------------------------------------------------------------
 * Calm / Pro dashboard toggle. Two pills, sliding active state.
 *
 *   Calm   — the friendly Today view (SMB owners, default)
 *   Pro    — the dense War Room (freelancers / agencies, opt-in)
 *
 * On click:
 *   1. Optimistically updates the visible pill.
 *   2. Writes `maroa.view=<mode>` cookie (1-year TTL) so SSR knows on the
 *      next request.
 *   3. router.refresh() so the current dashboard route re-fetches with
 *      the new mode.
 * ---------------------------------------------------------------------------
 */

const OPTIONS: { value: ViewMode; label: string; icon: typeof Sparkles; description: string }[] = [
  { value: 'calm', label: 'Calm', icon: Sparkles, description: 'Friendly Today view' },
  { value: 'pro', label: 'Pro', icon: Layers, description: 'Dense War Room' },
];

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string) {
  const oneYearSeconds = 60 * 60 * 24 * 365;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${oneYearSeconds}; SameSite=Lax`;
}

export function ViewModeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<ViewMode>(DEFAULT_VIEW_MODE);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Hydrate from cookie after mount. Avoids server/client mismatch since
  // we don't have access to next/headers in a client component.
  useEffect(() => {
    setMode(parseViewMode(readCookie(VIEW_MODE_COOKIE)));
  }, []);

  function switchTo(next: ViewMode) {
    if (next === mode) return;
    setMode(next);
    writeCookie(VIEW_MODE_COOKIE, next);
    startTransition(() => {
      // Re-fetch the current route with the new cookie. Both /dashboard
      // and /dashboard/pro listen for the cookie via the SSR fetch.
      router.push(next === 'pro' ? '/dashboard/pro' : '/dashboard');
      router.refresh();
    });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Dashboard view"
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-full bg-ink-100 dark:bg-ink-800 border border-ink-200/60 dark:border-ink-700/60',
        className,
      )}
    >
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={pending}
            onClick={() => switchTo(o.value)}
            title={o.description}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full transition-colors min-h-[36px] px-3 text-xs font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
              active
                ? 'bg-white dark:bg-ink-900 text-ink-700 dark:text-ink-100 shadow-subtle'
                : 'text-ink-500 dark:text-ink-300 hover:text-ink-700 dark:hover:text-ink-100',
              pending && 'opacity-60',
            )}
          >
            <o.icon className="h-3.5 w-3.5" aria-hidden="true" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
