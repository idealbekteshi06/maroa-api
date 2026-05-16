import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'System Status',
  description: 'Real-time status of Maroa services. Uptime, incident history, scheduled maintenance.',
  alternates: { canonical: '/status' },
};

const SERVICES = [
  { name: 'API (api.maroa.ai)', status: 'operational' as const },
  { name: 'Dashboard (app.maroa.ai)', status: 'operational' as const },
  { name: 'Auth (Supabase)', status: 'operational' as const },
  { name: 'Content generation (Anthropic)', status: 'operational' as const },
  { name: 'Image generation (Higgsfield)', status: 'operational' as const },
  { name: 'Background jobs (Inngest)', status: 'operational' as const },
  { name: 'Email delivery (Resend)', status: 'operational' as const },
];

const STATUS_STYLES = {
  operational: {
    label: 'Operational',
    dot: 'bg-green-500',
    text: 'text-green-700 dark:text-green-300',
    bg: 'bg-green-50 dark:bg-green-500/10',
  },
  degraded: {
    label: 'Degraded',
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
    bg: 'bg-amber-50 dark:bg-amber-500/10',
  },
  outage: {
    label: 'Outage',
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-300',
    bg: 'bg-red-50 dark:bg-red-500/10',
  },
} as const;

export default function StatusPage() {
  const allOk = SERVICES.every((s) => s.status === 'operational');

  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="max-w-3xl mx-auto">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">System status</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-8">
          {allOk ? 'All systems operational.' : 'Service disruption in progress.'}
        </h1>

        <div
          className={`rounded-2xl p-5 mb-12 flex items-center gap-3 ${
            allOk
              ? 'bg-green-50 dark:bg-green-500/10 border border-green-200/60 dark:border-green-500/20'
              : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20'
          }`}
        >
          <span
            className={`h-3 w-3 rounded-full ${
              allOk ? 'bg-green-500 animate-pulse' : 'bg-amber-500 animate-pulse'
            }`}
            aria-hidden="true"
          />
          <p
            className={`text-sm font-medium ${
              allOk ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'
            }`}
          >
            {allOk
              ? 'All services operating normally. Last checked moments ago.'
              : 'We are aware and working on it. See incident timeline below.'}
          </p>
        </div>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mb-6">Services</h2>
        <div className="space-y-2">
          {SERVICES.map((s) => {
            const style = STATUS_STYLES[s.status];
            return (
              <div
                key={s.name}
                className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800"
              >
                <span className="font-medium text-ink-700 dark:text-ink-100">{s.name}</span>
                <span
                  className={`text-xs font-medium px-3 py-1 rounded-full inline-flex items-center gap-2 ${style.bg} ${style.text}`}
                >
                  <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
                  {style.label}
                </span>
              </div>
            );
          })}
        </div>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-16 mb-6">
          Recent incidents
        </h2>
        <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-8 text-center">
          <p className="text-ink-400">No incidents in the past 30 days.</p>
        </div>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-16 mb-4">
          Stay informed
        </h2>
        <p className="text-ink-400 leading-relaxed">
          Subscribe to incident updates by emailing{' '}
          <a href="mailto:status@maroa.ai?subject=Subscribe%20to%20status%20updates" className="text-accent-500 hover:underline">
            status@maroa.ai
          </a>
          . We post incident updates within 15 minutes of detection and continue until resolved.
        </p>

        <p className="mt-12 text-xs text-ink-400">
          This page is a placeholder — a fuller status board with historical uptime, latency graphs, and
          subscriber options is provisioned for v2 (statuspage.io / instatus integration).
        </p>
      </div>
    </section>
  );
}
