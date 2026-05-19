import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { PlanPanel } from '@/components/dashboard/settings/plan-panel';

export const metadata: Metadata = {
  title: 'Plan & billing · Settings',
  robots: { index: false, follow: false },
};

export default async function PlanSettingsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  const currentPlan = feed.workspace?.plan_tier || 'solo';
  return (
    <PageFrame
      eyebrow="Settings · Plan & billing"
      title="Your plan."
      subtitle="Switch tiers any time. Up-grades pro-rate to the day; down-grades take effect at the next billing cycle."
    >
      <PlanPanel currentPlan={currentPlan} />
    </PageFrame>
  );
}
