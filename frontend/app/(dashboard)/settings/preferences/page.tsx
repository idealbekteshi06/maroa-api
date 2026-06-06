import type { Metadata } from 'next';
import { ComingSoon } from '@/components/dashboard/coming-soon';

export const metadata: Metadata = {
  title: 'AI preferences · Settings',
  robots: { index: false, follow: false },
};

/**
 * /settings/preferences — linked from the settings hub. Autopilot level +
 * posting prefs aren't wired to a backend write path yet, so this is an
 * honest ComingSoon instead of a 404.
 */
export default function PreferencesSettingsPage() {
  return (
    <ComingSoon
      eyebrow="Settings · AI preferences"
      title="AI preferences"
      description="Tune how Maroa works on your behalf — how autonomous it is, when it posts, and which channels it creates for."
      bullets={[
        'Autopilot level — suggest only, approve-then-act, or full auto',
        'Preferred posting times per channel',
        'Channel mix — which platforms Maroa creates for',
        'Quiet hours + weekly volume caps',
      ]}
      primary={{ label: 'Back to settings', href: '/settings' }}
    />
  );
}
