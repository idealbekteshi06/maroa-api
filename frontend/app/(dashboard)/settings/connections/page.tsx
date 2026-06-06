import type { Metadata } from 'next';
import { PageFrame } from '@/components/dashboard/page-frame';
import {
  ConnectionsList,
  type IntegrationStatus,
} from '@/components/dashboard/settings/connections-list';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { fetchIntegrationsSSR } from '@/lib/api/integrations.server';
import { cn } from '@/lib/cn';

// Per-user live integration status + OAuth return params — always dynamic.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connections · Settings',
  robots: { index: false, follow: false },
};

/**
 * /settings/connections — connect external accounts. Status pills reflect
 * live state from GET /api/business/:id/integrations. The OAuth callbacks
 * redirect back here with ?meta=connected|error|cancelled (or ?google=…),
 * which we surface as a banner.
 *
 * businessId is taken from the *real* workspace feed only (not the mock
 * fallback) so we never offer a Connect button bound to a demo UUID that
 * the backend would reject.
 */

type SearchParams = Record<string, string | string[] | undefined>;

const PROVIDER_LABELS: Record<string, string> = {
  meta: 'Instagram + Facebook',
  google: 'Google Ads',
};

function resolveNotice(sp: SearchParams): { tone: 'ok' | 'error' | 'muted'; text: string } | null {
  for (const provider of ['meta', 'google'] as const) {
    const raw = sp[provider];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) continue;
    const label = PROVIDER_LABELS[provider];
    if (value === 'connected') return { tone: 'ok', text: `${label} connected. You're all set.` };
    if (value === 'cancelled') return { tone: 'muted', text: `${label} connection was cancelled.` };
    if (value === 'error') {
      const reasonRaw = sp.reason;
      const reason = Array.isArray(reasonRaw) ? reasonRaw[0] : reasonRaw;
      return {
        tone: 'error',
        text: `${label} connection failed${reason ? `: ${reason}` : '. Please try again.'}`,
      };
    }
  }
  return null;
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const notice = resolveNotice(sp);

  const realFeed = await fetchActiveWorkspaceFeedSSR();
  const businessId = realFeed?.clients?.[0]?.business_id ?? null;
  const health = businessId ? await fetchIntegrationsSSR(businessId) : null;
  const integrations: IntegrationStatus[] = (health?.integrations ?? []).map((i) => ({
    key: i.key,
    label: i.label,
    connected: i.connected,
    status: i.status,
    detail: i.detail ?? null,
  }));

  return (
    <PageFrame
      eyebrow="Settings · Connections"
      title="Connect your accounts."
      subtitle="Maroa needs read-write access to publish posts and run ads. We never post without your approval."
    >
      {notice && (
        <div
          className={cn(
            'rounded-xl border px-5 py-4 text-sm leading-relaxed',
            notice.tone === 'ok' &&
              'border-green-200/60 dark:border-green-500/20 bg-green-50/60 dark:bg-green-500/10 text-green-800 dark:text-green-200',
            notice.tone === 'error' &&
              'border-red-200/60 dark:border-red-500/20 bg-red-50/60 dark:bg-red-500/10 text-red-800 dark:text-red-200',
            notice.tone === 'muted' &&
              'border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 text-ink-700 dark:text-ink-100',
          )}
        >
          {notice.text}
        </div>
      )}
      <ConnectionsList businessId={businessId} integrations={integrations} />
    </PageFrame>
  );
}
