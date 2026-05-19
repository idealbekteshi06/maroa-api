import Link from 'next/link';
import {
  Building2,
  Plug,
  Palette,
  CreditCard,
  Users,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { BrandVoice } from '@/lib/api/business';
import type { Workspace } from '@/lib/api/workspaces';

/**
 * components/dashboard/settings/settings-shell.tsx
 * ---------------------------------------------------------------------------
 * Settings home — six clearly-named cards that route to per-section pages.
 *
 * Each card surfaces a *status* (connected · needs setup · default) so the
 * customer can see at a glance what still needs their attention. No
 * jargon, no nested tabs.
 *
 * Sections:
 *   1. Business profile      — name, industry, region, goal
 *   2. Connections           — Meta, Google, LinkedIn, etc. OAuth state
 *   3. Brand voice           — tone + do/don't word list
 *   4. Plan & billing        — current plan, switch tier, Paddle portal
 *   5. Team (Agency only)    — invites + roles
 *   6. AI preferences        — autopilot on/off, posting times
 * ---------------------------------------------------------------------------
 */

interface SettingsShellProps {
  workspace: Workspace | null;
  brandVoice: BrandVoice | null;
  hasConnectedMeta?: boolean;
  hasConnectedGoogle?: boolean;
  plan?: string;
}

function statusPill(label: string, tone: 'ok' | 'attention' | 'muted') {
  const styles = {
    ok: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300',
    attention: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
    muted: 'bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300',
  } as const;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', styles[tone])}>
      {label}
    </span>
  );
}

export function SettingsShell({
  workspace,
  brandVoice,
  hasConnectedMeta,
  hasConnectedGoogle,
  plan,
}: SettingsShellProps) {
  const cards: Array<{
    href: string;
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
    status: React.ReactNode;
    show?: boolean;
  }> = [
    {
      href: '/settings/profile',
      icon: Building2,
      title: 'Business profile',
      description: workspace?.name
        ? `Set up for ${workspace.name}.`
        : 'Name, industry, region, primary goal.',
      status: workspace?.name ? statusPill('Set up', 'ok') : statusPill('Needs setup', 'attention'),
    },
    {
      href: '/settings/connections',
      icon: Plug,
      title: 'Connections',
      description: 'Meta, Google, LinkedIn, TikTok — connect to publish and run ads.',
      status:
        hasConnectedMeta && hasConnectedGoogle
          ? statusPill('All connected', 'ok')
          : hasConnectedMeta || hasConnectedGoogle
            ? statusPill('Partly connected', 'attention')
            : statusPill('Not connected', 'attention'),
    },
    {
      href: '/settings/brand-voice',
      icon: Palette,
      title: 'Brand voice',
      description: brandVoice?.tone
        ? `Tone: ${brandVoice.tone}.`
        : 'How Maroa writes for you — tone, words to use, words to avoid.',
      status: brandVoice ? statusPill('Tuned', 'ok') : statusPill('Default', 'muted'),
    },
    {
      href: '/settings/plan',
      icon: CreditCard,
      title: 'Plan & billing',
      description: plan
        ? `Currently on ${capitalize(plan)}.`
        : 'Manage your subscription, switch tier, or update payment.',
      status: statusPill(plan ? capitalize(plan) : 'Free', 'muted'),
    },
    {
      href: '/settings/team',
      icon: Users,
      title: 'Team',
      description: 'Invite teammates and set roles (owner, strategist, designer, viewer).',
      status: statusPill('Agency only', 'muted'),
      show: workspace?.plan_tier === 'agency' || workspace?.plan_tier === 'enterprise',
    },
    {
      href: '/settings/preferences',
      icon: Sparkles,
      title: 'AI preferences',
      description: 'Autopilot on/off, preferred posting times, content channels.',
      status: statusPill('Default', 'muted'),
    },
  ];

  const visible = cards.filter((c) => c.show !== false);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {visible.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="group rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle hover:shadow-card hover:border-ink-300 dark:hover:border-ink-700 transition-all p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
        >
          <div className="flex items-start gap-4">
            <span
              aria-hidden="true"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 shrink-0"
            >
              <c.icon className="h-5 w-5" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg text-ink-700 dark:text-ink-50 font-semibold">
                  {c.title}
                </h2>
                {c.status}
              </div>
              <p className="mt-1 text-sm text-ink-500 dark:text-ink-300 leading-relaxed">
                {c.description}
              </p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
