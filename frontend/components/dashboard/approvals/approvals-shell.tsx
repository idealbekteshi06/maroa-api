'use client';

import { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { ApprovalCard } from '@/components/dashboard/today/approval-card';
import { EmptyState } from '@/components/ui/empty-state';
import type { DecisionLogRow, WorkspaceFeed } from '@/lib/types/war-room';
import { decisionCategory } from '@/lib/translate';
import { cn } from '@/lib/cn';

/**
 * components/dashboard/approvals/approvals-shell.tsx
 * ---------------------------------------------------------------------------
 * Dedicated approval inbox. Same approval card as the calm dashboard,
 * but here it's the only thing on the page so the user can plow through
 * a batch.
 *
 * Top bar:
 *   - "Count" pill (3 to review)
 *   - Filter chips (All · Content · Ads · Compliance · Other)
 *   - Empty state when nothing is pending
 *
 * Card list is single column on mobile, two-column on lg+ (more density
 * for the user who's specifically here to triage).
 *
 * Optimistic resolution — each approve/reject fades the card immediately;
 * Sonner toast confirms or surfaces an error.
 * ---------------------------------------------------------------------------
 */

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'content', label: 'Content' },
  { value: 'ads', label: 'Ads' },
  { value: 'creative', label: 'Creative' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'budget', label: 'Budget' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

function collectPending(feed: WorkspaceFeed): DecisionLogRow[] {
  const by = new Map<string, DecisionLogRow>();
  for (const c of feed.clients) for (const d of c.recent_decisions) by.set(d.id, d);
  return Array.from(by.values())
    .filter((d) => d.required_approval && !d.executed && !d.refused)
    .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
}

export function ApprovalsShell({ feed }: { feed: WorkspaceFeed }) {
  const pending = useMemo(() => collectPending(feed), [feed]);
  const [filter, setFilter] = useState<Filter>('all');
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const live = pending.filter((d) => !resolved.has(d.id));
    if (filter === 'all') return live;
    return live.filter((d) => decisionCategory(d) === filter);
  }, [pending, resolved, filter]);

  const visibleCount = filtered.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                'inline-flex items-center rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
                active
                  ? 'bg-ink-700 text-white dark:bg-white dark:text-ink-900 shadow-subtle'
                  : 'bg-ink-50 dark:bg-ink-900 text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800',
              )}
              aria-pressed={active}
            >
              {f.label}
            </button>
          );
        })}
        <span className="ml-auto text-sm text-ink-500 dark:text-ink-300">
          {visibleCount === 0
            ? 'Nothing pending'
            : `${visibleCount} ${visibleCount === 1 ? 'thing' : 'things'} to review`}
        </span>
      </div>

      {visibleCount === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Your inbox is clear."
          description="I'll surface anything new here. You can close the tab — I'll keep working."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((d) => (
            <ApprovalCard
              key={d.id}
              workspaceId={feed.workspace.id}
              decision={d}
              onResolved={(id) =>
                setResolved((prev) => {
                  const next = new Set(prev);
                  next.add(id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
