import type { Metadata } from 'next';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ApiTokensPanel } from '@/components/dashboard/settings/api-tokens-panel';

export const metadata: Metadata = {
  title: 'API tokens · Settings',
  robots: { index: false, follow: false },
};

export default function ApiTokensSettingsPage() {
  return (
    <PageFrame
      eyebrow="Settings · API tokens"
      title="API tokens."
      subtitle="Use these to connect the CLI, browser extension, or your own scripts to Maroa. Each token can be revoked any time."
    >
      <ApiTokensPanel />
    </PageFrame>
  );
}
