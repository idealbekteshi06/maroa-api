import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Building2,
  Users,
  Palette,
  Plug,
  CreditCard,
  Shield,
  Bell,
  Database,
  ChevronRight,
} from 'lucide-react';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };

const SECTIONS = [
  {
    eyebrow: 'Workspace',
    items: [
      {
        href: '/settings/workspace',
        icon: Building2,
        title: 'Workspace details',
        body: 'Name, slug, region, white-label.',
      },
      {
        href: '/settings/team',
        icon: Users,
        title: 'Team & roles',
        body: 'Invite teammates · owner / strategist / designer / client / viewer.',
      },
      {
        href: '/settings/clients',
        icon: Users,
        title: 'Client list',
        body: 'Manage clients, retainers, status (active / paused / offboarded).',
      },
    ],
  },
  {
    eyebrow: 'Brand',
    items: [
      {
        href: '/settings/voice',
        icon: Palette,
        title: 'Brand voice',
        body: 'Voice signature, tone anchors, sample copy. Reviewed on every draft.',
      },
      {
        href: '/settings/dna',
        icon: Palette,
        title: 'Visual DNA',
        body: 'Soul ID, brand palette, style anchors — cached for Higgsfield.',
      },
    ],
  },
  {
    eyebrow: 'Connections',
    items: [
      {
        href: '/api/oauth/meta/start',
        icon: Plug,
        title: 'Meta (Facebook + Instagram)',
        body: 'Required for posting + Meta ad audits.',
        external: true,
      },
      {
        href: '/api/oauth/google/start',
        icon: Plug,
        title: 'Google Ads',
        body: 'Required for auditing + optimizing Google campaigns.',
        external: true,
      },
      {
        href: '/api/oauth/linkedin/start',
        icon: Plug,
        title: 'LinkedIn',
        body: 'Required for LinkedIn page publishing.',
        external: true,
      },
      {
        href: '/api/oauth/tiktok/start',
        icon: Plug,
        title: 'TikTok',
        body: 'Required for TikTok publishing + ads.',
        external: true,
      },
    ],
  },
  {
    eyebrow: 'Account',
    items: [
      {
        href: '/settings/billing',
        icon: CreditCard,
        title: 'Plan & billing',
        body: 'Manage plan, invoices, payment method — via Paddle.',
      },
      {
        href: '/settings/notifications',
        icon: Bell,
        title: 'Notifications',
        body: 'Approval inbox, pacing alerts, weekly scorecards.',
      },
      {
        href: '/settings/security',
        icon: Shield,
        title: 'Security',
        body: 'Login activity, sessions, 2FA, magic-link reset.',
      },
      {
        href: '/settings/data',
        icon: Database,
        title: 'Data & export',
        body: 'Export everything (.zip) · close account · data residency.',
      },
    ],
  },
];

export default function SettingsPage() {
  return (
    <>
      <header className="mb-10">
        <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
          Settings
        </h1>
        <p className="mt-2 text-ink-400">
          Workspace, brand, integrations, billing, and account.
        </p>
      </header>

      <div className="space-y-12">
        {SECTIONS.map((section) => (
          <section key={section.eyebrow}>
            <p className="text-eyebrow uppercase text-ink-400 mb-4">{section.eyebrow}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {section.items.map((item) =>
                'external' in item && item.external ? (
                  <a
                    key={item.href}
                    href={item.href}
                    className="group flex items-start gap-4 rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 hover:border-ink-300 dark:hover:border-ink-700 p-5 transition-colors"
                  >
                    <SettingsItemContent item={item} />
                  </a>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex items-start gap-4 rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 hover:border-ink-300 dark:hover:border-ink-700 p-5 transition-colors"
                  >
                    <SettingsItemContent item={item} />
                  </Link>
                ),
              )}
            </div>
          </section>
        ))}

        {/* Danger zone */}
        <section>
          <p className="text-eyebrow uppercase text-red-700 dark:text-red-400 mb-4">Danger zone</p>
          <div className="rounded-xl border border-red-200/60 dark:border-red-500/20 bg-red-50/30 dark:bg-red-500/5 p-6">
            <h3 className="text-base font-semibold text-ink-700 dark:text-ink-100">Close account</h3>
            <p className="mt-1 text-sm text-ink-400 leading-relaxed max-w-2xl">
              Closes your account, exports a .zip of everything Maroa made for you, and deletes or
              anonymizes data within 30 days. Some records (tax, audit) retained per legal requirement.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border border-red-300 dark:border-red-500/30 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
            >
              Close account…
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function SettingsItemContent({
  item,
}: {
  item: { icon: typeof Building2; title: string; body: string };
}) {
  const Icon = item.icon;
  return (
    <>
      <div className="h-10 w-10 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center flex-shrink-0">
        <Icon className="h-5 w-5 text-ink-700 dark:text-ink-100" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-100 flex items-center gap-1">
          {item.title}
        </h3>
        <p className="mt-0.5 text-sm text-ink-400 leading-snug">{item.body}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-ink-300 dark:text-ink-600 group-hover:text-ink-400 transition-colors flex-shrink-0 mt-1" />
    </>
  );
}
