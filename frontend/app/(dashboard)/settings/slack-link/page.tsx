import type { Metadata } from 'next';
import { PageFrame } from '@/components/dashboard/page-frame';
import { SlackLinkConfirm } from '@/components/dashboard/settings/slack-link-confirm';

export const metadata: Metadata = {
  title: 'Connect Slack · Settings',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ slack_user?: string; slack_team?: string }>;
}

export default async function SlackLinkPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const slackUser = (params.slack_user || '').toString();
  const slackTeam = (params.slack_team || '').toString();
  return (
    <PageFrame
      eyebrow="Settings · Slack"
      title="Connect your Slack account."
      subtitle="One click to link this Maroa account to the Slack user who ran /maroa link."
    >
      <SlackLinkConfirm slackUserId={slackUser} slackTeamId={slackTeam || null} />
    </PageFrame>
  );
}
