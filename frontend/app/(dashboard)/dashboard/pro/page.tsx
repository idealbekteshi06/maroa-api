import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { WarRoomShell } from '@/components/dashboard/war-room/war-room-shell';

export const metadata: Metadata = {
  title: 'War Room — Pro view',
  robots: { index: false, follow: false },
};

/**
 * /dashboard/pro — the dense operator view (the original War Room).
 *
 * Surface for freelancer + agency power users who want all clients,
 * KPIs, decisions, and experiments in one screen. SMB owners default to
 * the calm /dashboard view; this route is opt-in via the sidebar Calm/Pro
 * toggle (writes the maroa.view cookie).
 *
 * Same SSR data path as /dashboard so the two views are always in sync
 * on first paint.
 */
export default async function WarRoomProPage() {
  const realFeed = await fetchActiveWorkspaceFeedSSR();
  return (
    <WarRoomShell
      fallbackFeed={realFeed ?? mockWorkspaceFeed}
      initialIsDemo={!realFeed}
    />
  );
}
