import { SectionSkeleton } from '@/components/dashboard/section-skeleton';

export default function Loading() {
  return <SectionSkeleton title="Campaigns" description="Loading audits and active campaigns…" kind="cards" rows={4} />;
}
