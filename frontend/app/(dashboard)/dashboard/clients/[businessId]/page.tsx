import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ClientDetail } from '@/components/dashboard/clients/client-detail';

export const metadata: Metadata = {
  title: 'Client',
  robots: { index: false, follow: false },
};

/**
 * /dashboard/clients/[businessId] — per-client drill-in.
 *
 * Uses the same war-room SSR feed (no second backend route) and picks
 * the matching client by id. 404 if no match.
 */
export default async function ClientDrillInPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  const client = feed.clients.find((c) => c.business_id === businessId);
  if (!client) notFound();

  const name = client.client?.client_name || 'Client';
  const retainer = client.client?.monthly_retainer_usd
    ? `$${client.client.monthly_retainer_usd}/mo retainer`
    : null;

  return (
    <PageFrame
      eyebrow="Client"
      title={name}
      subtitle={retainer || `What I'm doing for ${name}, in one view.`}
      wide
    >
      <ClientDetail feed={client} />
    </PageFrame>
  );
}
