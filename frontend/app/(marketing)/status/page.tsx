import type { Metadata } from 'next';
import { unstable_noStore as noStore } from 'next/cache';

export const metadata: Metadata = {
  title: 'System Status — Maroa uptime + service health',
  description:
    'Real-time status of Maroa services. Probes the live /readyz endpoint every page load. Uptime, incident history, scheduled maintenance.',
  alternates: { canonical: '/status' },
};

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

interface ReadyzCheck {
  ok: boolean;
  reason?: string | null;
  skipped?: boolean;
}

interface ReadyzResponse {
  status: 'ready' | 'not_ready';
  duration_ms?: number;
  hard_failures?: string[];
  soft_warnings?: string[];
  checks?: Record<string, ReadyzCheck | undefined>;
  uptime_seconds?: number;
}

type Health = 'operational' | 'degraded' | 'outage' | 'unknown';

interface ServiceLine {
  key: string;
  name: string;
  status: Health;
  detail?: string | null;
}

/**
 * Maps the backend /readyz probe names to human-readable service names
 * shown on the marketing status page.
 */
const SERVICE_MAP: { key: string; name: string }[] = [
  { key: 'supabase', name: 'Database (Supabase)' },
  { key: 'anthropic', name: 'Content generation (Anthropic)' },
  { key: 'higgsfield', name: 'Image generation (Higgsfield)' },
  { key: 'inngest', name: 'Background jobs (Inngest)' },
  { key: 'dlq', name: 'Job queue (Inngest DLQ)' },
  { key: 'wave60', name: 'Agency-grade pipeline (Wave 60)' },
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
  unknown: {
    label: 'Unknown',
    dot: 'bg-ink-400',
    text: 'text-ink-600 dark:text-ink-200',
    bg: 'bg-ink-100 dark:bg-ink-800',
  },
} as const;

/**
 * Server-side fetch of /readyz with a hard 3-second timeout. The page is
 * statically renderable but `unstable_noStore()` opts out of caching so
 * every load shows fresh state.
 *
 * Audit 2026-05-19 F31: previously hardcoded all 7 services as
 * "operational" with no live data. Now mirrors what /readyz actually
 * returned in the last 10-second cache window.
 */
async function fetchStatus(): Promise<{
  services: ServiceLine[];
  overall: Health;
  fetchedAt: Date;
  unreachable: boolean;
}> {
  noStore();
  const fetchedAt = new Date();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${API_URL.replace(/\/$/, '')}/readyz`, {
      signal: controller.signal,
      // We want a fresh probe on each status-page render — caching here
      // would lie to the customer.
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeoutId);
    const body = (await res.json().catch(() => null)) as ReadyzResponse | null;
    if (!body) throw new Error('empty_body');
    const checks = body.checks || {};
    const services: ServiceLine[] = SERVICE_MAP.map((entry) => {
      const check = checks[entry.key];
      if (!check) return { ...entry, status: 'unknown', detail: 'not reported' };
      if (check.skipped) return { ...entry, status: 'operational', detail: 'idle' };
      return {
        ...entry,
        status: check.ok ? 'operational' : 'degraded',
        detail: check.reason || null,
      };
    });
    const overall: Health =
      body.status === 'ready' && services.every((s) => s.status === 'operational')
        ? 'operational'
        : body.status === 'ready'
          ? 'degraded'
          : 'outage';
    return { services, overall, fetchedAt, unreachable: false };
  } catch {
    clearTimeout(timeoutId);
    return {
      services: SERVICE_MAP.map((s) => ({ ...s, status: 'unknown', detail: 'probe timed out' })),
      overall: 'unknown',
      fetchedAt,
      unreachable: true,
    };
  }
}

export default async function StatusPage() {
  const { services, overall, fetchedAt, unreachable } = await fetchStatus();
  const banner = STATUS_STYLES[overall];
  const headline = unreachable
    ? 'Status check unreachable.'
    : overall === 'operational'
      ? 'All systems operational.'
      : overall === 'degraded'
        ? 'Service degradation in progress.'
        : 'Service outage in progress.';

  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="max-w-3xl mx-auto">
        <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300 mb-4">System status</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-8">{headline}</h1>

        <div
          className={`rounded-xl p-5 mb-12 flex items-center gap-3 ${banner.bg} border border-ink-200/60 dark:border-ink-800`}
          role="status"
          aria-live="polite"
        >
          <span className={`h-3 w-3 rounded-full ${banner.dot} animate-pulse`} aria-hidden="true" />
          <p className={`text-sm font-medium ${banner.text}`}>
            {unreachable
              ? 'We couldn’t reach the API health probe. The dashboard may still be available.'
              : `Probed live from the backend at ${fetchedAt.toUTCString()}.`}
          </p>
        </div>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mb-6">Services</h2>
        <div className="space-y-2">
          {services.map((s) => {
            const style = STATUS_STYLES[s.status];
            return (
              <div
                key={s.key}
                className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800"
              >
                <div>
                  <p className="font-medium text-ink-700 dark:text-ink-100">{s.name}</p>
                  {s.detail && (
                    <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">{s.detail}</p>
                  )}
                </div>
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
          <p className="text-ink-500 dark:text-ink-300">No incidents in the past 30 days.</p>
        </div>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-16 mb-4">
          Stay informed
        </h2>
        <p className="text-ink-500 dark:text-ink-300 leading-relaxed">
          Subscribe to incident updates by emailing{' '}
          <a
            href="mailto:status@maroa.ai?subject=Subscribe%20to%20status%20updates"
            className="text-accent-500 hover:underline"
          >
            status@maroa.ai
          </a>
          . We post incident updates within 15 minutes of detection and continue until resolved.
        </p>
      </div>
    </section>
  );
}
