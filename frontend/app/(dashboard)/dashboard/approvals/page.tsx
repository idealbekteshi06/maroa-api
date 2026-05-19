import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ApprovalsShell } from '@/components/dashboard/approvals/approvals-shell';

export const metadata: Metadata = {
  title: 'Approvals',
  robots: { index: false, follow: false },
};

/**
 * /dashboard/approvals — the focused inbox view.
 *
 * Same Approval Card pattern as the calm dashboard, but here it's the
 * whole page so the customer can plow through a batch in one sitting.
 * Filter chips by category. Optimistic UI with Sonner confirmations.
 */
export default async function ApprovalsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  return (
    <PageFrame
      eyebrow="Inbox"
      title="Things I need a yes or no on."
      subtitle="Plow through the list. I’ll keep drafting more once you’re caught up."
      wide
    >
      <ApprovalsShell feed={feed} />
    </PageFrame>
  );
}
