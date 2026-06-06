'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Sparkles,
  Users,
  Inbox,
  PenSquare,
  BarChart3,
  FlaskConical,
  FileBarChart,
  Palette,
  Settings,
  LogOut,
} from 'lucide-react';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { ViewModeToggle } from '@/components/dashboard/view-mode-toggle';
import { cn } from '@/lib/cn';
import { logOut } from '@/lib/api/auth';
import { useDashboardBadges } from '@/components/dashboard/sidebar-badges-context';

// Grouped navigation — closer to the AI marketing-OS surface area the
// product audit asked for. Each item routes to a real page (stubs land
// gracefully via routes/*/page.tsx; replace with real surfaces as the
// agency-pipeline UI ships).
const NAV_GROUPS: { label: string; items: { href: string; label: string; icon: typeof LayoutDashboard }[] }[] = [
  {
    label: 'Command',
    items: [
      { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
      { href: '/dashboard/brain', label: 'AI Brain', icon: Sparkles },
      { href: '/dashboard/approvals', label: 'Approvals', icon: Inbox },
      { href: '/dashboard/clients', label: 'Clients', icon: Users },
    ],
  },
  {
    label: 'Work',
    items: [
      { href: '/content', label: 'Content Studio', icon: PenSquare },
      { href: '/ads', label: 'Campaigns', icon: BarChart3 },
      { href: '/dashboard/creative', label: 'Creative Studio', icon: Palette },
      { href: '/dashboard/experiments', label: 'Experiments', icon: FlaskConical },
    ],
  },
  {
    label: 'Insight',
    items: [
      { href: '/dashboard/reports', label: 'Reports', icon: FileBarChart },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const badges = useDashboardBadges();
  // Map nav href → badge to render. `0` (or empty string) renders nothing.
  const badgeFor: Record<string, { value: number | string; tone: 'amber' | 'accent' | 'red' } | undefined> = {
    '/dashboard/approvals': badges.approvals
      ? { value: badges.approvals, tone: 'amber' }
      : undefined,
    '/dashboard/clients': badges.clients
      ? { value: badges.clients, tone: 'accent' }
      : undefined,
    '/settings': badges.settings
      ? { value: badges.settings, tone: 'red' }
      : undefined,
  };
  const toneClass: Record<'amber' | 'accent' | 'red', string> = {
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    accent: 'bg-accent-100 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  };

  return (
    <aside className="hidden lg:flex w-60 flex-col border-r border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950">
      <div className="px-6 py-6">
        <Logo />
      </div>
      <nav className="flex-1 px-3 space-y-5 overflow-y-auto" aria-label="Dashboard">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-3 mb-1.5 text-[10px] uppercase tracking-wider text-ink-400 font-medium">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                // Highest-specificity active: dashboard root is active only on /dashboard exactly
                const active =
                  item.href === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors',
                      active
                        ? 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100'
                        : 'text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-900',
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {badgeFor[item.href] && (
                      <span
                        className={cn(
                          'inline-flex items-center justify-center rounded-full h-4 min-w-[16px] px-1.5 text-[10px] font-semibold tabular-nums',
                          toneClass[badgeFor[item.href]!.tone],
                        )}
                        aria-label={`${badgeFor[item.href]!.value} pending`}
                      >
                        {badgeFor[item.href]!.value}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="p-3 border-t border-ink-200/60 dark:border-ink-800 space-y-2">
        {/* View-mode toggle — Calm vs Pro dashboard. Writes the maroa.view
            cookie so the SSR route picks the right shell on next nav. */}
        <div className="flex items-center justify-between px-3">
          <span className="text-xs text-ink-500 dark:text-ink-300">View</span>
          <ViewModeToggle />
        </div>
        <div className="flex items-center justify-between px-3">
          <span className="text-xs text-ink-500 dark:text-ink-300">Theme</span>
          <ThemeToggle />
        </div>
        <button
          onClick={() => logOut().then(() => (window.location.href = '/'))}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-900 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
