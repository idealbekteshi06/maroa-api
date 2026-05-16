import type { Metadata } from 'next';
import Link from 'next/link';
import { Inbox, Clock, CheckCircle2, XCircle, ChevronRight } from 'lucide-react';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';

export const metadata: Metadata = { title: 'Approvals', robots: { index: false } };

export default function ApprovalsPage() {
  const feed = mockWorkspaceFeed;
  const pending = feed.pending_approvals;

  return (
    <>
      <header className="mb-8">
        <p className="text-eyebrow uppercase text-ink-400 mb-2">Inbox</p>
        <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
          Approvals
        </h1>
        <p className="mt-2 text-ink-400 max-w-2xl">
          Everything Maroa drafted that needs a human signoff — yours or your client&apos;s. Magic-link
          for clients means they approve from their phone without an account.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Pending', value: pending.length, tone: 'amber' },
          { label: 'Approved 7d', value: 18, tone: 'green' },
          { label: 'Rejected 7d', value: 2, tone: 'default' },
          { label: 'Avg response time', value: '4h 12m', tone: 'default' },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-4"
          >
            <p className="text-xs uppercase tracking-wider text-ink-400">{k.label}</p>
            <p
              className={`text-2xl font-semibold tracking-tight mt-1 ${
                k.tone === 'amber'
                  ? 'text-amber-700 dark:text-amber-400'
                  : k.tone === 'green'
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-ink-700 dark:text-ink-100'
              }`}
            >
              {k.value}
            </p>
          </div>
        ))}
      </section>

      <div className="space-y-3">
        {pending.map((a) => {
          const client = feed.clients.find((c) => c.business_id === a.business_id);
          return (
            <Link
              key={a.id}
              href={`/dashboard/approvals/${a.id}`}
              className="flex items-start gap-4 rounded-2xl bg-white dark:bg-ink-900 border border-amber-200/60 dark:border-amber-500/20 hover:border-amber-300 dark:hover:border-amber-500/40 p-5 transition-colors"
            >
              <div className="h-10 w-10 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20 flex items-center justify-center flex-shrink-0">
                <Inbox className="h-5 w-5 text-amber-700 dark:text-amber-300" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-xs text-ink-400 uppercase tracking-wider">
                    {client?.client.client_name || a.business_id}
                  </p>
                  <span className="text-ink-300">·</span>
                  <p className="text-xs text-ink-400">{a.client_email}</p>
                </div>
                <p className="text-sm font-medium text-ink-700 dark:text-ink-100">
                  Awaiting client review
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Expires {new Date(a.expires_at).toLocaleDateString()}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-ink-400 flex-shrink-0 mt-2" />
            </Link>
          );
        })}

        {pending.length === 0 && (
          <div className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-3" />
            <p className="text-ink-700 dark:text-ink-100 font-medium">Inbox zero.</p>
            <p className="text-sm text-ink-400 mt-1">All clear. Nothing waiting for your signoff.</p>
          </div>
        )}
      </div>
    </>
  );
}
