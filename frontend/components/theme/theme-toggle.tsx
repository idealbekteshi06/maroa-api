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
            className={cn(
              'h-7 w-7 inline-flex items-center justify-center rounded-full transition-colors',
              active
                ? 'bg-white dark:bg-ink-900 text-ink-700 dark:text-ink-100 shadow-subtle'
                : 'text-ink-400 hover:text-ink-700 dark:hover:text-ink-100',
            )}
            title={o.label}
          >
            <o.icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
