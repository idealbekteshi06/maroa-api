import Link from 'next/link';
import { ArrowRight, TrendingUp, TrendingDown } from 'lucide-react';
import type { ClientFeed } from '@/lib/types/war-room';

function DecayBar({ buckets, total }: { buckets: Record<string, number>; total: number }) {
  if (total === 0) return null;
  const pct = (n: number) => (n / total) * 100;
  return (
    <div className="flex h-1.5 w-full rounded-full overflow-hidden bg-ink-100 dark:bg-ink-800">
      <span style={{ width: `${pct(buckets.fresh)}%` }} className="bg-green-500" title={`Fresh: ${buckets.fresh}`} />
      <span style={{ width: `${pct(buckets.maturing)}%` }} className="bg-accent-500" title={`Maturing: ${buckets.maturing}`} />
      <span style={{ width: `${pct(buckets.decaying)}%` }} className="bg-amber-500" title={`Decaying: ${buckets.decaying}`} />
      <span style={{ width: `${pct(buckets.dead)}%` }} className="bg-red-500" title={`Dead: ${buckets.dead}`} />
    </div>
  );
}

export function ClientCard({ client }: { client: ClientFeed }) {
  const decayingOrDead = client.decay_buckets.decaying + client.decay_buckets.dead;
  const decayBad = client.creatives_total > 0 && decayingOrDead / client.creatives_total > 0.3;
  const pendingDecisions = client.recent_decisions.filter((d) => d.required_approval && !d.refused).length;
  const refusalsLast7d = client.recent_decisions.filter(
    (d) => d.refused && new Date(d.created_at) > new Date(Date.now() - 7 * 86400000),
  ).length;

  return (
    <Link
      href={`/dashboard/client/${client.business_id}`}
      className="brand-edge block rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 hover:border-ink-300 dark:hover:border-ink-600 transition-colors p-5"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-ink-700 dark:text-ink-100 truncate">
            {client.client.client_name || 'Unnamed client'}
          </h3>
          {client.client.monthly_retainer_usd && (
            <p className="text-xs text-ink-400 mt-0.5">
              ${client.client.monthly_retainer_usd.toLocaleString()} / month
            </p>
          )}
        </div>
        <ArrowRight className="h-4 w-4 text-ink-400" aria-hidden="true" />
      </div>

      {/* Decay bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-ink-400">Creative health</span>
          <span className="text-xs font-medium text-ink-700 dark:text-ink-200">
            {client.creatives_total} live
          </span>
        </div>
        <DecayBar buckets={client.decay_buckets} total={client.creatives_total} />
        {decayBad && (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            {decayingOrDead} need refresh
          </p>
        )}
      </div>

      {/* Mini badges */}
      <div className="flex flex-wrap gap-2 text-xs">
        {pendingDecisions > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
            {pendingDecisions} pending
          </span>
        )}
        {client.experiments_running.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-50 text-accent-700 dark:bg-accent-500/10 dark:text-accent-300">
            {client.experiments_running.length} testing
          </span>
        )}
        {client.competitor_alerts.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {client.competitor_alerts.length} alerts
          </span>
        )}
        {refusalsLast7d > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200">
            {refusalsLast7d} refusals
          </span>
        )}
        {pendingDecisions === 0 &&
          client.competitor_alerts.length === 0 &&
          refusalsLast7d === 0 && (
            <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
              <TrendingUp className="h-3 w-3" />
              Healthy
            </span>
          )}
      </div>
    </Link>
  );
}
