/**
 * components/dashboard/section-skeleton.tsx
 * ---------------------------------------------------------------------------
 * Generic dashboard section skeleton — used by loading.tsx files across
 * /content, /ads, /settings, /onboarding so navigation never lands on a
 * blank page (audit 2026-05-19 F10).
 *
 * Branded look: same surface treatment as `<Card>` (rounded-xl, hairline
 * border, ink-50 fill) with a subtle motion-safe pulse. Honors
 * `prefers-reduced-motion` — falls back to static fill at the same
 * contrast so the layout intent still reads.
 *
 * Variant API:
 *   - `title` — string shown above the skeleton grid (lets the loading state
 *     announce the destination so the user knows the click landed).
 *   - `rows` — number of skeleton rows in the body (default 4).
 *   - `kind` — 'cards' | 'list' | 'form' — different rhythms.
 *
 * Server component. Renders zero JS.
 * ---------------------------------------------------------------------------
 */

import { cn } from '@/lib/cn';

type Kind = 'cards' | 'list' | 'form';

interface SectionSkeletonProps {
  title?: string;
  description?: string;
  rows?: number;
  kind?: Kind;
}

function Block({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-md bg-ink-100 dark:bg-ink-800 motion-safe:animate-pulse',
        className,
      )}
    />
  );
}

export function SectionSkeleton({
  title,
  description,
  rows = 4,
  kind = 'cards',
}: SectionSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="px-5 sm:px-8 py-8 sm:py-10"
    >
      <span className="sr-only">Loading{title ? ` ${title}` : ''}…</span>

      <div className="max-w-6xl mx-auto space-y-6">
        <div className="space-y-2">
          {title ? (
            <h1 className="text-display-md text-ink-700 dark:text-ink-100">{title}</h1>
          ) : (
            <Block className="h-9 w-48" />
          )}
          {description ? (
            <p className="text-ink-500 dark:text-ink-300 max-w-2xl">{description}</p>
          ) : (
            <Block className="h-4 w-72 max-w-full" />
          )}
        </div>

        {kind === 'cards' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: rows }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 shadow-subtle p-6 space-y-3"
              >
                <Block className="h-4 w-24" />
                <Block className="h-8 w-32" />
                <Block className="h-3 w-full" />
              </div>
            ))}
          </div>
        )}

        {kind === 'list' && (
          <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 shadow-subtle divide-y divide-ink-200/60 dark:divide-ink-800">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="p-5 flex items-center gap-4">
                <Block className="h-10 w-10 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Block className="h-4 w-1/3" />
                  <Block className="h-3 w-2/3" />
                </div>
                <Block className="h-8 w-20 hidden sm:block" />
              </div>
            ))}
          </div>
        )}

        {kind === 'form' && (
          <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 shadow-subtle p-6 sm:p-8 space-y-5 max-w-2xl">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Block className="h-4 w-32" />
                <Block className="h-11 w-full" />
              </div>
            ))}
            <div className="flex justify-end gap-3 pt-2">
              <Block className="h-11 w-24 rounded-full" />
              <Block className="h-11 w-32 rounded-full" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
