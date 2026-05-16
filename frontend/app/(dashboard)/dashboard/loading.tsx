import { WarRoomSkeleton } from '@/components/dashboard/war-room/war-room-skeleton';

/**
 * Next App Router loading boundary — fires automatically while the server
 * resolves the route. Renders the same 3-band scaffolding the live page
 * uses so navigation into /dashboard never flashes blank.
 */
export default function Loading() {
  return <WarRoomSkeleton />;
}
