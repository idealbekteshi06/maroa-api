import { SectionSkeleton } from '@/components/dashboard/section-skeleton';

export default function Loading() {
  return <SectionSkeleton title="Welcome to Maroa" description="Preparing your onboarding…" kind="form" rows={3} />;
}
