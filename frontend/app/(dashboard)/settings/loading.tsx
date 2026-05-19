import { SectionSkeleton } from '@/components/dashboard/section-skeleton';

export default function Loading() {
  return <SectionSkeleton title="Settings" description="Loading your workspace settings…" kind="form" rows={5} />;
}
