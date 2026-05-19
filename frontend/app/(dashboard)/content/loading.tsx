import { SectionSkeleton } from '@/components/dashboard/section-skeleton';

export default function Loading() {
  return <SectionSkeleton title="Content Studio" description="Loading your draft pipeline…" kind="cards" rows={4} />;
}
