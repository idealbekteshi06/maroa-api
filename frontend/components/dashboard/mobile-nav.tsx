'use client';

import { useEffect, useState } from 'react';
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
  Menu,
  X,
} from 'lucide-react';
import { Logo } from '@/components/marketing/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { cn } from '@/lib/cn';
import { logOut } from '@/lib/api/auth';
import { useFocusTrap } from '@/lib/use-focus-trap';

/**
 * Mobile navigation — bottom bar with 4 primary destinations + a "More"
 * drawer that exposes the full sidebar surface. Mirrors NAV_GROUPS from
 * sidebar.tsx exactly so freelancers + agencies can manage approvals,
 * clients, creative, experiments, reports from their phone.
 */

const PRIMARY = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/dashboard/approvals', label: 'Approvals', icon: Inbox },
  { href: '/dashboard/clients', label: 'Clients', icon: Users },
];

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

export function MobileNav() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Audit 2026-05-19 F14: trap Tab/Shift+Tab inside the dialog while open.
  const drawerRef = useFocusTrap<HTMLDivElement>(drawerOpen);

  // Auto-close on route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  // ESC to close.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <nav
        aria-label="Primary"
        className={cn(
          'lg:hidden fixed bottom-0 inset-x-0 z-30',
          'bg-white/95 dark:bg-ink-950/95 backdrop-blur-xl border-t border-ink-200/60 dark:border-ink-800',
          'pb-[max(env(safe-area-inset-bottom),0px)]',
        )}
      >
        <ul className="flex">
          {PRIMARY.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 min-h-14 px-2 py-2 text-xs font-medium transition-colors',
                    active
                      ? 'text-ink-700 dark:text-ink-100'
                      : 'text-ink-400 hover:text-ink-700 dark:hover:text-ink-100',
                  )}
                >
                  <item.icon
                    className={cn('h-5 w-5 transition-transform', active && 'scale-110')}
                    strokeWidth={active ? 2.2 : 1.8}
                  />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex-1">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              className="w-full flex flex-col items-center justify-center gap-1 min-h-14 px-2 py-2 text-xs font-medium text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 transition-colors"
            >
              <Menu className="h-5 w-5" strokeWidth={1.8} />
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>

      {/* Drawer — full menu mirror of desktop sidebar */}
      <div
        ref={drawerRef}
        id="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Full menu"
        className={cn(
          'lg:hidden fixed inset-0 z-40 transition-opacity duration-200',
          drawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      >
        {/* Scrim */}
        <button
          type="button"
          tabIndex={-1}
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="absolute inset-0 bg-ink-900/40 dark:bg-black/60 backdrop-blur-sm"
        />

        {/* Panel — slides up */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 max-h-[90vh] flex flex-col',
            'bg-white dark:bg-ink-950 border-t border-ink-200/60 dark:border-ink-800',
            'rounded-t-2xl shadow-2xl',
            'pb-[max(env(safe-area-inset-bottom),0px)]',
            'transition-transform duration-300 ease-out',
            drawerOpen ? 'translate-y-0' : 'translate-y-full',
          )}
        >
          {/* Grab handle */}
          <div className="pt-2 pb-1 flex justify-center">
            <span className="h-1 w-10 rounded-full bg-ink-200 dark:bg-ink-800" aria-hidden="true" />
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-b border-ink-200/60 dark:border-ink-800">
            <Logo />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="-mr-2 h-10 w-10 rounded-full flex items-center justify-center text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-900 transition-colors"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="px-3 mb-1.5 text-[10px] uppercase tracking-wider text-ink-400 font-medium">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isActive(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium transition-colors',
                          active
                            ? 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100'
                            : 'text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-900',
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="px-3 py-3 border-t border-ink-200/60 dark:border-ink-800 space-y-2">
            <div className="flex items-center justify-between px-3">
              <span className="text-xs text-ink-400">Theme</span>
              <ThemeToggle />
            </div>
            <button
              onClick={() => {
                setDrawerOpen(false);
                logOut().then(() => (window.location.href = '/'));
              }}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-medium text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-900 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
