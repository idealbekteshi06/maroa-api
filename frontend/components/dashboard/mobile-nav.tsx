'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, PenSquare, BarChart3, Settings } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Mobile bottom navigation bar — visible only on screens < lg.
 *
 * Pairs with `components/dashboard/sidebar.tsx` which renders the desktop
 * sidebar. Five primary destinations, large touch targets (h-14, w-1/4),
 * safe-area-padding for iOS home indicator.
 */

const NAV = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/content', label: 'Content', icon: PenSquare },
  { href: '/ads', label: 'Ads', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className={cn(
        'lg:hidden fixed bottom-0 inset-x-0 z-30',
        'bg-white/95 backdrop-blur-xl border-t border-ink-200/60',
        // iOS safe-area inset
        'pb-[max(env(safe-area-inset-bottom),0px)]',
      )}
    >
      <ul className="flex">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center justify-center gap-1',
                  'min-h-14 px-2 py-2 text-xs font-medium transition-colors',
                  active ? 'text-ink-700' : 'text-ink-400 hover:text-ink-700',
                )}
              >
                <item.icon
                  className={cn(
                    'h-5 w-5 transition-transform',
                    active && 'scale-110',
                  )}
                  strokeWidth={active ? 2.2 : 1.8}
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
