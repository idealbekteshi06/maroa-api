import type { Metadata } from 'next';
import { ComingSoon } from '@/components/dashboard/coming-soon';

export const metadata: Metadata = { title: 'Creative Studio', robots: { index: false } };

export default function CreativeStudioPage() {
  return (
    <ComingSoon
      eyebrow="Visual production"
      title="Creative Studio"
      description="The Higgsfield-powered visual production engine. Generate brand-consistent images, videos, motion graphics, and product photography from a single brief — with QA gates + brand voice DNA cached per client."
      bullets={[
        'Visual Production Compiler — brief → JobSpec → 7 intent presets (meta-ads-image, instagram-reel, ugc-video, product-photo, motion-graphic, …)',
        'Brand Visual DNA per client — Soul ID + palette + style anchors cached for re-use',
        'Higgsfield model router — Cinema Studio, Veo, Seedance, Kling, Nano Banana, Vibe Motion',
        'QA checklist per platform: aspect ratio, captions, compliance, brand consistency',
        'Compliance pre-check before model spend (FDA, FTC, Meta personal-attributes)',
        'Quality vs cost routing — flagship for important launches, cheap for daily volume',
        'Asset library with version history + reasoning trace for every render',
      ]}
      primary={{ label: 'See the agency-pipeline architecture', href: '/features' }}
    />
  );
}
