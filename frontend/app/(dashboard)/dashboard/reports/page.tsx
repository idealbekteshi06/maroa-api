import type { Metadata } from 'next';
import Link from 'next/link';
import { ComingSoon } from '@/components/dashboard/coming-soon';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { FileBarChart, ArrowRight, Mail } from 'lucide-react';

export const metadata: Metadata = { title: 'Reports', robots: { index: false } };

export default function ReportsPage() {
  const clients = mockWorkspaceFeed.clients;

  return (
    <>
      <header className="mb-8">
        <p className="text-eyebrow uppercase text-ink-400 mb-2">Client deliverables</p>
        <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
          Reports
        </h1>
        <p className="mt-2 text-ink-400 max-w-2xl">
          Branded weekly scorecards your clients actually want to read. Maroa drafts the narrative,
          attaches the numbers, and sends a magic-link PDF every Sunday at 22:00 their time.
        </p>
      </header>

      <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 mb-4">
        Next scorecard run
        <span className="text-xs font-normal text-ink-400 ml-2">— Sun 22:00 UTC</span>
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-12">
        {clients.map(({ client, creatives_total, experiments_running, decay_buckets }) => {
          const decaying = decay_buckets.decaying + decay_buckets.dead;
          return (
            <article
              key={client.id}
              className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-100 truncate">
                  {client.client_name || client.business_id}
                </h3>
                <FileBarChart className="h-4 w-4 text-ink-400 flex-shrink-0" />
              </div>
              <dl className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <dt className="text-ink-400">Creatives shipped</dt>
                  <dd className="font-mono text-ink-700 dark:text-ink-100">{creatives_total}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-ink-400">Tests running</dt>
                  <dd className="font-mono text-ink-700 dark:text-ink-100">
                    {experiments_running.length}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-ink-400">Needs refresh</dt>
                  <dd className="font-mono text-ink-700 dark:text-ink-100">{decaying}</dd>
                </div>
              </dl>
              <Link
                href={`/dashboard/clients/${client.business_id}`}
                className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400"
              >
                Preview draft
                <ArrowRight className="h-3 w-3" />
              </Link>
            </article>
          );
        })}
      </div>

      <div className="mt-10">
        <ComingSoon
          eyebrow="Coming soon"
          title="Report Studio"
          description="One-click branded weekly + monthly scorecards. White-labelled per client, narrated by your reasoning trace, and delivered by magic-link or email — no PDF assembly, no Loom recording, no Sunday-night slog."
          bullets={[
            'Auto-generated weekly scorecard (Sun 22:00 client-local) — narrative + numbers',
            'Monthly executive summary — wins, losses, learnings, next-month plan',
            'White-label PDF with your logo, your tone, your brand palette',
            'Magic-link share — no client login required',
            'Per-client custom KPI stacks (lead-gen vs e-comm vs SaaS)',
            'Auto-cited reasoning trace — every claim links back to a decision log entry',
            'Email + Slack delivery — preview before send, schedule per timezone',
          ]}
        />
      </div>

      <div className="mt-8 rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 max-w-3xl">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center flex-shrink-0">
            <Mail className="h-5 w-5 text-ink-700 dark:text-ink-100" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-100">
              Want it before launch?
            </h3>
            <p className="mt-1 text-sm text-ink-400 leading-snug">
              Weekly scorecard already runs on the backend (services/wf6). Email delivery is live —
              connect your client&apos;s email in their settings and you&apos;ll receive a copy Sunday.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
