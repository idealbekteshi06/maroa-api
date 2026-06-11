import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { fetchPlansSSR } from '@/lib/api/plans.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { PlanPanel } from '@/components/dashboard/settings/plan-panel';

// currentPlan is per-user; the plan catalog fetch sets a data-cache revalidate
// which would otherwise make the whole page ISR. Force per-request rendering
// so each user sees their own current plan (catalog stays cached at the fetch).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plan & billing · Settings',
  robots: { index: false, follow: false },
};

export default async function PlanSettingsPage() {
  // Price + features come from the backend catalog (GET /api/billing/plans)
  // so the cards can't drift from the real plan gating.
  const [feed, catalog] = await Promise.all([fetchActiveWorkspaceFeedSSR(), fetchPlansSSR()]);
  const currentPlan = (feed ?? mockWorkspaceFeed).workspace?.plan_tier || 'solo';
  return (
    <PageFrame
      eyebrow="Settings · Plan & billing"
      title="Your plan."
      subtitle="Switch tiers any time. Up-grades pro-rate to the day; down-grades take effect at the next billing cycle."
    >
      <PlanPanel currentPlan={currentPlan} catalog={catalog} />
    </PageFrame>
  );
}
