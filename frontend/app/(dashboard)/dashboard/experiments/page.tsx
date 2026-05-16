import type { Metadata } from 'next';
import { ComingSoon } from '@/components/dashboard/coming-soon';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { FlaskConical, TrendingUp } from 'lucide-react';

export const metadata: Metadata = { title: 'Experiments', robots: { index: false } };

export default function ExperimentsPage() {
  const running = mockWorkspaceFeed.clients.flatMap((c) =>
    c.experiments_running.map((e) => ({
      ...e,
      _clientName: c.client.client_name || c.business_id,
    })),
  );

  return (
    <>
      <header className="mb-8">
        <p className="text-eyebrow uppercase text-ink-400 mb-2">Autonomous testing</p>
        <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
          Experiments
        </h1>
        <p className="mt-2 text-ink-400 max-w-2xl">
          Hypothesis → variants → spend → outcome. Maroa proposes the test, runs it, scores the
          winner statistically, kills the losers, and stores what worked.
        </p>
      </header>

      <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 mb-4">
        Running now
        <span className="text-xs font-normal text-ink-400 ml-2">— {running.length}</span>
      </h2>

      {running.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-12 text-center">
          <FlaskConical className="h-8 w-8 text-ink-300 dark:text-ink-700 mx-auto mb-3" />
          <p className="text-ink-400">No active experiments.</p>
        </div>
      ) : (
        <div className="space-y-3 mb-12">
          {running.map((e) => (
            <article
              key={e.id}
              className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs uppercase tracking-wider text-ink-400">
                      {e._clientName}
                    </span>
                    <span className="text-ink-300">·</span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300 font-mono">
                      {e.variant_count} variants
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 font-mono inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      running
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-ink-700 dark:text-ink-100">
                    {e.name}
                  </h3>
                  {e.hypothesis && (
                    <p className="text-sm text-ink-400 mt-1 leading-snug">{e.hypothesis}</p>
                  )}
                </div>
                <TrendingUp className="h-4 w-4 text-ink-400 flex-shrink-0" />
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="mt-10">
        <ComingSoon
          eyebrow="Coming soon"
          title="Experiment Engine"
          description="Auto-propose A/B tests from your Marketing Graph, predict winners before running, kill losers automatically, and store every learning back into the graph so the next test starts smarter."
          bullets={[
            'Auto-proposed experiments from Creative Genome decomposition',
            'Statistical confidence threshold per metric (Bayesian)',
            'Predicted winner before spend, validated after',
            'Kill-loser automation with traffic re-allocation',
            'Outcome storage in marketing_graph_edges for compounding learning',
          ]}
        />
      </div>
    </>
  );
}
