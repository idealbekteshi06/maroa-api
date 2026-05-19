import type { Metadata } from 'next';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { PageFrame } from '@/components/dashboard/page-frame';
import { SettingsShell } from '@/components/dashboard/settings/settings-shell';
import type { Workspace } from '@/lib/api/workspaces';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
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
        hasConnectedMeta={false}
        hasConnectedGoogle={false}
        plan={feed.workspace?.plan_tier}
      />
    </PageFrame>
  );
}
