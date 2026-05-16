'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
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
import { cn } from '@/lib/cn';
import { logOut } from '@/lib/api/auth';

// Grouped navigation — closer to the AI marketing-OS surface area the
// product audit asked for. Each item routes to a real page (stubs land
// gracefully via routes/*/page.tsx; replace with real surfaces as the
// agency-pipeline UI ships).
const NAV_GROUPS: { label: string; items: { href: string; label: string; icon: typeof LayoutDashboard }[] }[] = [
  {
    label: 'Command',
    items: [
      { href: '/dashboard', label: 'War Room', icon: LayoutDashboard },
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
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="p-3 border-t border-ink-200/60 dark:border-ink-800 space-y-2">
        <div className="flex items-center justify-between px-3">
          <span className="text-xs text-ink-400">Theme</span>
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
