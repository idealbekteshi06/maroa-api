import Link from 'next/link';
import { Users, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { friendlyTime } from '@/lib/translate';
import type { ClientFeed, WorkspaceFeed } from '@/lib/types/war-room';

/**
 * components/dashboard/clients/clients-shell.tsx
 * ---------------------------------------------------------------------------
 * Agency-mode client list. One row per client with:
 *   - Client name + monthly retainer
 *   - Health pill (Working great / Mixed / Needs attention) derived from
 *     pending approvals, decaying creatives, experiment status
 *   - Last decision activity
 *   - Drill-in link to /dashboard/clients/[businessId]
 *
 * Renders EmptyState when the workspace has no clients yet.
 * ---------------------------------------------------------------------------
 */

type Health = 'good' | 'mixed' | 'attention';

function healthOf(c: ClientFeed): { tone: Health; label: string } {
  const decaying = c.decay_buckets?.decaying || 0;
  const dead = c.decay_buckets?.dead || 0;
  const fading = decaying + dead;
  const pendingApprovals = c.recent_decisions.filter(
    (d) => d.required_approval && !d.executed && !d.refused,
  ).length;

  if (c.error) return { tone: 'attention', label: 'Needs attention' };
  if (fading > 3 || pendingApprovals > 5) return { tone: 'attention', label: 'Needs attention' };
  if (fading > 0 || pendingApprovals > 0) return { tone: 'mixed', label: 'Mixed' };
  return { tone: 'good', label: 'Working great' };
}

const TONE_PILL = {
  good: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300',
  mixed: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
  attention: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
} as const;

const TONE_ICON = {
  good: CheckCircle2,
  mixed: AlertCircle,
  attention: AlertCircle,
} as const;

export function ClientsShell({ feed }: { feed: WorkspaceFeed }) {
  const clients = feed.clients || [];
  if (clients.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No clients yet."
        description="Add your first client from Settings → Team to start running Maroa across multiple businesses."
        primary={{ label: 'Go to Settings', href: '/settings/team' }}
      />
    );
  }

  return (
    <ol className="space-y-3">
      {clients.map((c) => {
        const h = healthOf(c);
        const Icon = TONE_ICON[h.tone];
        const lastDecision = c.recent_decisions[0];
        const pendingCount = c.recent_decisions.filter(
          (d) => d.required_approval && !d.executed && !d.refused,
        ).length;
        return (
          <li key={c.business_id}>
            <Link
              href={`/dashboard/clients/${encodeURIComponent(c.business_id)}`}
              className="group block rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle hover:shadow-card hover:border-ink-300 dark:hover:border-ink-700 transition-all px-5 sm:px-6 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
            >
              <div className="flex items-start gap-4">
                <span
                  aria-hidden="true"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100"
                >
                  <Users className="h-5 w-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg text-ink-700 dark:text-ink-50 font-semibold truncate">
                      {c.client?.client_name || c.business_id}
                    </h3>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
                        TONE_PILL[h.tone],
                      )}
                    >
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      {h.label}
                    </span>
                    {pendingCount > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300">
                        {pendingCount} pending
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
                    {c.creatives_total} {c.creatives_total === 1 ? 'piece' : 'pieces'} live
                    {c.client?.monthly_retainer_usd
                      ? ` · $${c.client.monthly_retainer_usd}/mo retainer`
                      : ''}
                  </p>
                  {lastDecision && (
                    <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
                      Last move {friendlyTime(lastDecision.created_at)}
                    </p>
                  )}
                </div>
                <ArrowRight
                  className="h-5 w-5 text-ink-400 self-center transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
