import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { AdsShell } from '@/components/dashboard/ads/ads-shell';

export const metadata: Metadata = {
  title: 'Campaigns',
  robots: { index: false, follow: false },
};

export default async function AdsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  return (
    <PageFrame
      eyebrow="Campaigns"
      title="How your ads are doing."
      subtitle="I’m watching every ad daily. Here’s what’s working and what I’ve already changed."
    >
      <AdsShell feed={feed} />
    </PageFrame>
  );
}
