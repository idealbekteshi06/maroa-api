'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, PenSquare, BarChart3, Settings, LogOut } from 'lucide-react';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { cn } from '@/lib/cn';
import { logOut } from '@/lib/api/auth';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/content', label: 'Content', icon: PenSquare },
  { href: '/ads', label: 'Ads', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex w-60 flex-col border-r border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950">
      <div className="px-6 py-6">
        <Logo />
      </div>
      <nav className="flex-1 px-3 space-y-1" aria-label="Dashboard">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
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
