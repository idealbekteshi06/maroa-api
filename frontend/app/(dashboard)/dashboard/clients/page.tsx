import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Users, ChevronRight } from 'lucide-react';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { ClientCard } from '@/components/dashboard/war-room/client-card';

export const metadata: Metadata = { title: 'Clients', robots: { index: false } };

export default function ClientsPage() {
  const feed = mockWorkspaceFeed;
  const totalRetainer = feed.clients.reduce(
    (s, c) => s + (c.client.monthly_retainer_usd || 0),
    0,
  );

  return (
    <>
      <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-eyebrow uppercase text-ink-400 mb-2">Workspace</p>
          <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
            Clients
          </h1>
          <p className="mt-2 text-ink-400 max-w-2xl">
            All the businesses your workspace manages. Add a new client, pause one, or offboard
            without losing the data.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-900 dark:hover:bg-ink-100 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add client
        </button>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Active clients', value: feed.clients.length },
          { label: 'Monthly retainer', value: `$${totalRetainer.toLocaleString()}` },
          { label: 'Avg per client', value: `$${Math.round(totalRetainer / Math.max(1, feed.clients.length))}` },
          { label: 'Plan cap', value: `${feed.clients.length} / 20` },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-4"
          >
            <p className="text-xs uppercase tracking-wider text-ink-400">{k.label}</p>
            <p className="text-2xl font-semibold tracking-tight text-ink-700 dark:text-ink-100 mt-1">
              {k.value}
            </p>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {feed.clients.map((c) => (
          <ClientCard key={c.client.id} client={c} />
        ))}

        {/* Add-new tile */}
        <Link
          href="/dashboard/clients/new"
          className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-ink-200 dark:border-ink-800 p-8 text-center hover:border-accent-400 hover:bg-accent-50/30 dark:hover:bg-accent-500/5 transition-colors"
        >
          <Plus className="h-6 w-6 text-ink-400 mb-2" />
          <p className="text-sm font-medium text-ink-700 dark:text-ink-100">Add a client</p>
          <p className="text-xs text-ink-400 mt-1">Or invite them with a magic link</p>
        </Link>
      </div>
    </>
  );
}
