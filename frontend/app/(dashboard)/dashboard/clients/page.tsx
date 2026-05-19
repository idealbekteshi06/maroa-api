import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ClientsShell } from '@/components/dashboard/clients/clients-shell';

export const metadata: Metadata = {
  title: 'Clients',
  robots: { index: false, follow: false },
};

export default async function ClientsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  return (
    <PageFrame
      eyebrow="Clients"
      title={`Your ${feed.clients.length === 1 ? 'client' : 'clients'}.`}
      subtitle="One row per business Maroa is running. Drill in to see what I'm doing for each."
      wide
    >
      <ClientsShell feed={feed} />
    </PageFrame>
  );
}
