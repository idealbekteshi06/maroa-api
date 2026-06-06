import type { Metadata } from 'next';
import { ComingSoon } from '@/components/dashboard/coming-soon';

export const metadata: Metadata = {
  title: 'Team · Settings',
  robots: { index: false, follow: false },
};

/**
 * /settings/team — linked from the settings hub (agency/enterprise) and the
 * empty Clients state. The backend has the workspace members + invites API
 * (routes/workspaces.js), but the management UI isn't built yet — so this is
 * an honest ComingSoon instead of a 404.
 */
export default function TeamSettingsPage() {
  return (
    <ComingSoon
      eyebrow="Settings · Team"
      title="Team & roles"
      description="Invite teammates to your workspace and control what each person can see and do. Available on Agency and Enterprise plans."
      bullets={[
        'Invite by email with roles: owner, strategist, designer, viewer',
        'Per-client visibility — give a freelancer access to only their accounts',
        'Shared approval inbox so the right person signs off',
        'Audit log of every change, export-ready',
      ]}
      primary={{ label: 'Compare plans', href: '/settings/plan' }}
    />
  );
}
