import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { BrandVoicePanel } from '@/components/dashboard/settings/brand-voice-panel';
import type { BrandVoice } from '@/lib/api/business';

export const metadata: Metadata = {
  title: 'Brand voice · Settings',
  robots: { index: false, follow: false },
};

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

/**
 * /settings/brand-voice — surfaces the brand-voice anchor Maroa uses to
 * write everything. SSR fetch from /api/business/:id/brand-voice (public
 * endpoint — anchor isn't sensitive).
 */
async function fetchBrandVoice(businessId: string): Promise<BrandVoice | null> {
  try {
    const r = await fetch(
      `${API_URL}/api/business/${encodeURIComponent(businessId)}/brand-voice?fallback=true`,
      { cache: 'no-store' },
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { voice?: BrandVoice };
    return body.voice || null;
  } catch {
    return null;
  }
}

export default async function BrandVoiceSettingsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  const businessId = feed.clients?.[0]?.business_id || '';
  const voice = businessId ? await fetchBrandVoice(businessId) : null;
  return (
    <PageFrame
      eyebrow="Settings · Brand voice"
      title="How Maroa writes for you."
      subtitle="The tone Maroa uses, the words it favors, and the words it avoids. Refined automatically as your customers respond, but you can override anything."
    >
      <BrandVoicePanel voice={voice} />
    </PageFrame>
  );
}
