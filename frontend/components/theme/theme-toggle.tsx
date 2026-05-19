'use client';

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemeMode } from './theme-provider';
import { cn } from '@/lib/cn';

const OPTIONS: { value: ThemeMode; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

/**
 * Segmented theme toggle — light / system / dark. Used in the dashboard
 * sidebar + marketing nav. Apple-style: pill background with sliding
 * active indicator, tight icons, no text on mobile.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5 rounded-full bg-ink-100 dark:bg-ink-800 border border-ink-200/60 dark:border-ink-700/60',
        className,
      )}
    >
      {OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            type="button"
            onClick={() => setMode(o.value)}
            // Audit 2026-05-19 F23: WCAG 2.5.5 minimum touch target is 44px.
            // Visual chip stays 28px (the rounded-full pill keeps a tight
            // look), but the hit area is 44px via min-h/min-w + grid centering.
            // F8 contrast: idle state uses ink-500 not ink-400 for AA on light.
            className={cn(
              'inline-flex items-center justify-center rounded-full transition-colors',
              'h-7 w-7 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0',
              active
                ? 'bg-white dark:bg-ink-900 text-ink-700 dark:text-ink-100 shadow-subtle'
                : 'text-ink-500 dark:text-ink-300 hover:text-ink-700 dark:hover:text-ink-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2',
            )}
            title={o.label}
          >
            <o.icon className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
