import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ProfileForm } from '@/components/dashboard/settings/profile-form';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';

export const metadata: Metadata = {
  title: 'Business profile · Settings',
  robots: { index: false, follow: false },
};

interface ServerProfile {
  business_name?: string;
  industry?: string;
  region?: string;
  audience?: string;
  goal?: string;
}

/**
 * Server-side fetch of the onboarding profile. Reads userId from the
 * Supabase session in cookies → GET /api/onboarding/profile/:userId.
 * Falls back to the workspace name if no profile exists.
 */
async function fetchProfile(): Promise<{ profile: ServerProfile; userId: string | null }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';
  if (!url || !anon) return { profile: {}, userId: null };
  const cookieStore = await cookies();
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {
        // server-side read only
      },
    },
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const userId = data.session?.user?.id || null;
  if (!token || !userId) return { profile: {}, userId: null };
  try {
    const res = await fetch(`${apiUrl}/api/onboarding/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { profile: {}, userId };
    const body = (await res.json()) as { profile?: ServerProfile };
    return { profile: body.profile || {}, userId };
  } catch {
    return { profile: {}, userId };
  }
}

export default async function ProfileSettingsPage() {
  const { profile, userId } = await fetchProfile();
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  const fallbackName = feed.workspace?.name || 'Your business';
  return (
    <PageFrame
      eyebrow="Settings · Profile"
      title="Your business profile."
      subtitle="The basics Maroa uses to draft content, target ads, and pick the right examples."
    >
      <ProfileForm
        userId={userId}
        initial={{
          business_name: profile.business_name || fallbackName,
          industry: profile.industry || '',
          region: profile.region || '',
          audience: profile.audience || '',
          goal: profile.goal || '',
        }}
      />
    </PageFrame>
  );
}
