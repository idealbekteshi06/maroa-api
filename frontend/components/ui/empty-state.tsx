import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * components/ui/empty-state.tsx
 * ---------------------------------------------------------------------------
 * Branded empty-state surface. Audit 2026-05-19 F26.
 *
 * Used by dashboard pages when there's no data yet — instead of rendering
 * a blank panel that looks broken, we show:
 *   - An iconic illustration (Lucide icon in a soft tile)
 *   - A title naming what's missing
 *   - A one-sentence description explaining what unlocks
 *   - A primary CTA (button or link) the user can click right now
 *   - An optional secondary link (docs, demo, sample data)
 *
 * Server-renderable. No client state.
 * ---------------------------------------------------------------------------
 */

interface ActionLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  primary?: ActionLink;
  secondary?: ActionLink;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  primary,
  secondary,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'mx-auto max-w-xl rounded-xl border border-ink-200/60 dark:border-ink-800',
        'bg-white dark:bg-ink-900 shadow-subtle px-6 py-10 sm:px-10 sm:py-14 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="mx-auto mb-6 inline-flex h-14 w-14 items-center justify-center rounded-xl bg-accent-50 dark:bg-accent-900/30 text-accent-500 dark:text-accent-300"
      >
        <Icon className="h-7 w-7" strokeWidth={1.8} />
      </div>
      <h2 className="text-xl font-semibold tracking-tight text-ink-700 dark:text-ink-50">
        {title}
      </h2>
      {description && (
        <p className="mt-3 text-ink-500 dark:text-ink-300 leading-relaxed">{description}</p>
      )}
      {(primary || secondary) && (
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          {primary && (
            <Link
              href={primary.href}
              {...(primary.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900 px-6 py-2.5 text-sm font-semibold hover:shadow-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
            >
              {primary.label}
            </Link>
          )}
          {secondary && (
            <Link
              href={secondary.href}
              {...(secondary.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="inline-flex items-center justify-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
            >
              {secondary.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
