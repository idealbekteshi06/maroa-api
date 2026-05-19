import Link from 'next/link';
import {
  PenSquare,
  BarChart3,
  Megaphone,
  ShieldCheck,
  Eye,
  Wallet,
  Users,
  FlaskConical,
  FileBarChart,
  Cog,
} from 'lucide-react';
import { friendly, friendlyTime, decisionCategory } from '@/lib/translate';
import type { DecisionLogRow } from '@/lib/types/war-room';

/**
 * components/dashboard/today/activity-feed.tsx
 * ---------------------------------------------------------------------------
 * "What I did" — the passive narration of the week's executed decisions.
 *
 * Reads from decision_log rows where `executed: true`. Translates each
 * row into one-line plain English via lib/translate.friendly().
 *
 * Renders as a vertical timeline with category icons. Time anchors are
 * fuzzy ("yesterday", "this morning", "last week") — no ISO timestamps
 * surfaced to the SMB-owner persona.
 *
 * Empty state when no executed decisions in the last 7 days. Maroa is
 * a fresh installation and hasn't shipped anything yet, so we say so.
 * ---------------------------------------------------------------------------
 */

const CATEGORY_ICONS = {
  content: PenSquare,
  ads: BarChart3,
  budget: Wallet,
  creative: Megaphone,
  experiment: FlaskConical,
  competitor: Eye,
  compliance: ShieldCheck,
  audience: Users,
  report: FileBarChart,
  system: Cog,
} as const;

export function ActivityFeed({
  decisions,
  detailsHref = '/dashboard/pro',
  maxItems = 6,
}: {
  decisions: DecisionLogRow[];
  detailsHref?: string;
  maxItems?: number;
}) {
  const shown = decisions
    .filter((d) => d.executed)
    .slice(0, maxItems);

  if (shown.length === 0) {
    return (
      <section aria-label="What I did" className="space-y-4">
        <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">What I did</h2>
        <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 px-6 py-8 text-center">
          <p className="text-ink-500 dark:text-ink-300">
            Just getting started. I’ll show you what I’ve done as soon as I ship the first piece.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="What I did" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">What I did</h2>
        {decisions.length > maxItems && (
          <Link
            href={detailsHref}
            className="text-sm text-accent-500 hover:text-accent-600 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 rounded"
          >
            See full activity
          </Link>
        )}
      </div>
      <ol className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle divide-y divide-ink-200/60 dark:divide-ink-800 overflow-hidden">
        {shown.map((d) => {
          const cat = decisionCategory(d);
          const Icon = CATEGORY_ICONS[cat] || Cog;
          return (
            <li key={d.id} className="px-5 sm:px-6 py-4 flex items-start gap-4">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100"
              >
                <Icon className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-ink-700 dark:text-ink-100 leading-snug">{friendly(d)}</p>
                <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
                  {friendlyTime(d.created_at)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
