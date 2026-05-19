import type { Metadata } from 'next';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ConnectionsList } from '@/components/dashboard/settings/connections-list';

export const metadata: Metadata = {
  title: 'Connections · Settings',
  robots: { index: false, follow: false },
};

/**
 * /settings/connections — list every external account the customer can
 * connect. The actual OAuth flow lives on the backend at /api/oauth/<provider>/start
 * — this page just renders the buttons + status pills.
 *
 * Status today is "Not connected" by default because the backend doesn't
 * yet expose a per-business GET /api/connections endpoint. When that
 * lands, replace the static array with a real fetch.
 */
export default function ConnectionsPage() {
  return (
    <PageFrame
      eyebrow="Settings · Connections"
      title="Connect your accounts."
      subtitle="Maroa needs read-write access to publish posts and run ads. We never post without your approval."
    >
      <ConnectionsList />
    </PageFrame>
  );
}
