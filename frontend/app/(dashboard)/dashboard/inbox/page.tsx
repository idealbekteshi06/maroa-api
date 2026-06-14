import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { InboxShell } from '@/components/dashboard/inbox/inbox-shell';

export const metadata: Metadata = {
  title: 'Inbox',
  robots: { index: false, follow: false },
};

// Per-user live inbox data — never prerender a shared shell.
export const dynamic = 'force-dynamic';

/**
 * /dashboard/inbox — WF9/WF11 unified inbox (read-mostly).
 *
 * businessId comes from the real workspace feed (clients[0]); null (demo /
 * pre-onboarding) renders a friendly setup prompt inside InboxShell.
 */
export default async function InboxPage() {
  const realFeed = await fetchActiveWorkspaceFeedSSR();
  const businessId = realFeed?.clients?.[0]?.business_id ?? null;
  return (
    <PageFrame
      eyebrow="Command"
      title="Unified inbox"
      subtitle="Every customer message — triaged, routed to the right specialist, and SLA-tracked in one place."
      wide
    >
      <InboxShell businessId={businessId} />
    </PageFrame>
  );
}
