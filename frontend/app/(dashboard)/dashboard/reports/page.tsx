import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ReportsShell } from '@/components/dashboard/reports/reports-shell';

export const metadata: Metadata = {
  title: 'Reports',
  robots: { index: false, follow: false },
};

export default async function ReportsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  return (
    <PageFrame
      eyebrow="Reports"
      title="How you’re trending."
      subtitle="Week-over-week movement on the things that matter. No CTR jargon."
      wide
    >
      <ReportsShell feed={feed} />
    </PageFrame>
  );
}
