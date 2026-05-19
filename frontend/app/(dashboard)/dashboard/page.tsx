import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { TodayShell } from '@/components/dashboard/today/today-shell';
import { parseViewMode, VIEW_MODE_COOKIE } from '@/lib/view-mode';

export const metadata: Metadata = {
  title: 'Today',
  robots: { index: false, follow: false },
};

/**
 * /dashboard — the new default. Calm "Today" view for the SMB-owner
 * persona that hired Maroa precisely to NOT think about marketing.
 *
 * Renders three sections in one column:
 *   1. Greeting + one-sentence summary of where things stand
 *   2. Pending approvals — big buttons, plain language, "why?" disclosure
 *   3. "What I did" passive activity feed
 *
 * SSR fetches the same WorkspaceFeed the War Room uses; we just reshape
 * the data instead of running a second backend route.
 *
 * View-mode cookie: if the user previously chose "pro", we redirect to
 * /dashboard/pro on this URL. The ViewModeToggle in the sidebar flips
 * the cookie and re-navigates.
 */
export default async function DashboardPage() {
  const cookieStore = await cookies();
  const mode = parseViewMode(cookieStore.get(VIEW_MODE_COOKIE)?.value);
  if (mode === 'pro') {
    redirect('/dashboard/pro');
  }

  const realFeed = await fetchActiveWorkspaceFeedSSR();
  const feed = realFeed ?? mockWorkspaceFeed;
  return (
    <TodayShell
      feed={feed}
      // firstName is wired through Supabase user metadata; null is a
      // graceful default that the Greeting component handles.
      firstName={null}
      initialIsDemo={!realFeed}
    />
  );
}
