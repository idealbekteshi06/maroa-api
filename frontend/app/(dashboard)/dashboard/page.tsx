import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { WarRoomShell } from '@/components/dashboard/war-room/war-room-shell';

export const metadata: Metadata = {
  title: 'War Room',
  robots: { index: false, follow: false },
};

/**
 * The War Room — the dashboard's reason to exist.
 *
 * Renders a client shell that fetches the real feed from
 * /api/war-room/:workspaceId via the authenticated API client, falling
 * back to the bundled mock so the first paint is never empty.
 */
export default function WarRoomPage() {
  return <WarRoomShell fallbackFeed={mockWorkspaceFeed} />;
}
