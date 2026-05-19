'use client';

import { Instagram, Facebook, Linkedin, Music2, Search, ExternalLink, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * components/dashboard/settings/connections-list.tsx
 * ---------------------------------------------------------------------------
 * Static-for-now list of connectable providers. Each card links to the
 * backend OAuth start endpoint. Status pills are placeholder ("Not
 * connected") until /api/connections lands.
 *
 * When the backend exposes per-business connection state, swap the
 * STATIC array for a useEffect fetch + reconcile.
 * ---------------------------------------------------------------------------
 */

interface Provider {
  key: string;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  startPath: string; // backend OAuth start
}

const PROVIDERS: Provider[] = [
  {
    key: 'meta',
    name: 'Instagram + Facebook',
    description: 'Publish posts, run Meta ads, and read insights.',
    icon: Instagram,
    startPath: '/api/oauth/meta/start',
  },
  {
    key: 'facebook',
    name: 'Facebook Page',
    description: 'Required for organic Facebook posts.',
    icon: Facebook,
    startPath: '/api/oauth/meta/start',
  },
  {
    key: 'google',
    name: 'Google Ads',
    description: 'Run search + display campaigns.',
    icon: Search,
    startPath: '/api/oauth/google/start',
  },
  {
    key: 'linkedin',
    name: 'LinkedIn',
    description: 'Publish to the company page and personal profile.',
    icon: Linkedin,
    startPath: '/api/oauth/linkedin/start',
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    description: 'Publish TikTok Business posts and run ads.',
    icon: Music2,
    startPath: '/api/oauth/tiktok/start',
  },
];

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export function ConnectionsList() {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 px-5 py-4 flex items-start gap-3">
        <ShieldCheck
          className="h-5 w-5 mt-0.5 text-accent-500 shrink-0"
          aria-hidden="true"
        />
        <div className="text-sm text-ink-700 dark:text-ink-100 leading-relaxed">
          Your tokens are stored encrypted (AES-256-GCM). You can disconnect any
          provider any time — the next attempt to use it will queue for re-auth
          instead of failing silently.
        </div>
      </div>
      <ol className="space-y-3">
        {PROVIDERS.map((p) => (
          <li
            key={p.key}
            className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-5 py-5 flex items-center gap-4"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 shrink-0"
            >
              <p.icon className="h-5 w-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-ink-700 dark:text-ink-50 font-semibold">{p.name}</p>
              <p className="text-sm text-ink-500 dark:text-ink-300">{p.description}</p>
            </div>
            <span
              className={cn(
                'hidden sm:inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                'bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300',
              )}
            >
              Not connected
            </span>
            <a
              href={`${API_URL}${p.startPath}`}
              className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:shadow-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
            >
              Connect
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
