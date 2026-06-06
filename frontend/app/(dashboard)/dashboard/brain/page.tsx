import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { BrainShell } from '@/components/dashboard/brain/brain-shell';

export const metadata: Metadata = {
  title: 'AI Brain',
  robots: { index: false, follow: false },
};

// Per-user, interactive chat — never prerender a shared shell.
export const dynamic = 'force-dynamic';

/**
 * /dashboard/brain — the WF15 conversational command center.
 *
 * We resolve the real businessId from the workspace feed (clients[0]) and hand
 * it to the client chat. Null (demo / pre-onboarding) renders a friendly
 * "finish setup" state inside BrainShell. The chat is full-height, so it does
 * NOT use PageFrame.
 */
export default async function BrainPage() {
  const realFeed = await fetchActiveWorkspaceFeedSSR();
  const businessId = realFeed?.clients?.[0]?.business_id ?? null;
  return <BrainShell businessId={businessId} />;
}
