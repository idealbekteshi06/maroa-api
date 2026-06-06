import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { fetchIntegrationsSSR } from '@/lib/api/integrations.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { SettingsShell } from '@/components/dashboard/settings/settings-shell';
import type { Workspace } from '@/lib/api/workspaces';

// Authenticated, per-user data (live connection status) — render per request
// so the pills reflect the signed-in user instead of a cached shell.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const realFeed = await fetchActiveWorkspaceFeedSSR();
  const feed = realFeed ?? mockWorkspaceFeed;

  // Connection status comes from the real business only — never the mock
  // fallback — so the hub pills tell the truth instead of always "Not
  // connected".
  const businessId = realFeed?.clients?.[0]?.business_id ?? null;
  const health = businessId ? await fetchIntegrationsSSR(businessId) : null;
  const connected = new Map((health?.integrations ?? []).map((i) => [i.key, i.connected]));

  const workspace: Workspace = feed.workspace
    ? {
        id: feed.workspace.id,
        name: feed.workspace.name,
        plan_tier: feed.workspace.plan_tier,
        created_at: feed.generated_at,
      }
    : {
        id: '',
        name: 'Your business',
        plan_tier: 'solo',
        created_at: new Date().toISOString(),
      };

  return (
    <PageFrame
      eyebrow="Settings"
      title="Set Maroa up the way you want it."
      subtitle="Connect your accounts, fine-tune the brand voice, manage your plan. Everything lives here."
      wide
    >
      <SettingsShell
        workspace={workspace}
        brandVoice={null}
        hasConnectedMeta={!!connected.get('meta')}
        hasConnectedGoogle={!!connected.get('google')}
        plan={feed.workspace?.plan_tier}
      />
    </PageFrame>
  );
}
