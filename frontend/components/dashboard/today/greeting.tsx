'use client';

import { useEffect, useState } from 'react';
import { greeting } from '@/lib/translate';

/**
 * components/dashboard/today/greeting.tsx
 * ---------------------------------------------------------------------------
 * Time-aware, name-aware salutation at the top of the calm dashboard.
 *
 * Why a client component: the greeting depends on the visitor's local
 * time of day, not the server's. A server-rendered "Morning" at 11 p.m.
 * Albania time reads as broken — so we update on mount.
 *
 * Renders a server-friendly fallback ("Welcome back") for SSR + the first
 * paint, then swaps to the correct period after hydration. The fallback
 * uses the same font weight/size to avoid CLS.
 * ---------------------------------------------------------------------------
 */

export function Greeting({
  firstName,
  fallback,
}: {
  firstName?: string | null;
  fallback?: string;
}) {
  const [text, setText] = useState<string>(fallback || 'Welcome back.');

  useEffect(() => {
    setText(greeting(firstName));
  }, [firstName]);

  return (
    <h1 className="text-display-md sm:text-display-lg text-ink-700 dark:text-ink-50 tracking-tight">
      {text}
    </h1>
  );
}
