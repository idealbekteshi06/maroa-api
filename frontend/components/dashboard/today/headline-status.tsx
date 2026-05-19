import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * components/dashboard/today/headline-status.tsx
 * ---------------------------------------------------------------------------
 * The one big outcome the customer cares about. We pick ONE number — the
 * thing a café owner would tell a friend ("we got 14 new leads this
 * week") — and surround it with a one-sentence narrative.
 *
 * Renders three intensities depending on the data:
 *
 *   - "things-going-well"  → green check + warm phrasing
 *   - "needs-attention"    → amber dot + neutral phrasing
 *   - "no-data-yet"        → friendly first-run state
 *
 * Charts deliberately not on this card. The "See the details" link
 * routes to /dashboard/reports for the power user; this card is the
 * abstract for the rest of the page.
 * ---------------------------------------------------------------------------
 */

type Tone = 'good' | 'neutral' | 'first-run';

export interface HeadlineStatusProps {
  /** The single biggest narrative outcome. */
  headline: string;
  /** A short phrase that fills in the context. */
  context?: string;
  /** Optional secondary one-liner — comparison, delta, etc. */
  detail?: string;
  /** "good" tints green, "neutral" tints amber/ink, "first-run" tints accent. */
  tone?: Tone;
  /** "See details" target — typically /dashboard/reports or /ads. */
  detailsHref?: string;
}

const TONE_STYLES: Record<Tone, { dot: string; halo: string; pill: string }> = {
  good: {
    dot: 'bg-green-500',
    halo: 'bg-green-500/10',
    pill: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300',
  },
  neutral: {
    dot: 'bg-amber-500',
    halo: 'bg-amber-500/10',
    pill: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  'first-run': {
    dot: 'bg-accent-500',
    halo: 'bg-accent-500/10',
    pill: 'bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300',
  },
};

export function HeadlineStatus({
  headline,
  context,
  detail,
  tone = 'good',
  detailsHref,
}: HeadlineStatusProps) {
  const t = TONE_STYLES[tone];
  return (
    <section
      aria-label="This week"
      className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle"
    >
      <div className="px-6 sm:px-8 py-7 sm:py-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-3">
            <span
              aria-hidden="true"
              className={cn('inline-flex items-center justify-center h-6 w-6 rounded-full', t.halo)}
            >
              <span className={cn('h-2 w-2 rounded-full', t.dot)} />
            </span>
            <span className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
              This week
            </span>
          </div>
          <p className="text-display-md text-ink-700 dark:text-ink-50 text-balance leading-tight">
            {headline}
          </p>
          {context && (
            <p className="mt-3 text-lg text-ink-500 dark:text-ink-300 leading-relaxed">
              {context}
            </p>
          )}
          {detail && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 mt-5 rounded-full px-3 py-1 text-xs font-medium',
                t.pill,
              )}
            >
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {detail}
            </span>
          )}
        </div>
        {detailsHref && (
          <Link
            href={detailsHref}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent-500 hover:text-accent-600 self-start sm:self-center whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 rounded"
          >
            See the details
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
      </div>
    </section>
  );
}
