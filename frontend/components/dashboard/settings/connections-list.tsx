'use client';

import { useState } from 'react';
import {
  Instagram,
  Search,
  Linkedin,
  Music2,
  ExternalLink,
  ShieldCheck,
  Check,
  Loader2,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { getSession } from '@/lib/api/auth';
import { cn } from '@/lib/cn';

/**
 * components/dashboard/settings/connections-list.tsx
 * ---------------------------------------------------------------------------
 * Real connection management. Status pills reflect live state from
 * GET /api/business/:businessId/integrations (passed in as props by the
 * server component). "Connect" kicks off the backend OAuth flow.
 *
 * OAuth start auth: the backend /webhook/oauth/{meta,google}/start routes
 * accept the Supabase JWT via a ?token= query param (a full-page redirect
 * can't set an Authorization header) and verify the JWT owns businessId
 * before issuing the signed state token. So the button is a client-side
 * navigation that attaches a fresh session token at click time.
 *
 * Meta + Google are fully wired today. LinkedIn + TikTok are shown as
 * "coming soon" because their OAuth round-trip still points at a legacy
 * redirect URI — we don't ship a button that dead-ends.
 * ---------------------------------------------------------------------------
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://maroa-api-production.up.railway.app';

export interface IntegrationStatus {
  key: string;
  label?: string;
  connected: boolean;
  status?: string; // 'healthy' | 'degraded' | 'disconnected'
  detail?: string | null;
}

interface ConnectionsListProps {
  /** The customer's business UUID. Null in demo mode / before onboarding. */
  businessId: string | null;
  /** Live integration health from the backend. */
  integrations: IntegrationStatus[];
}

type OAuthProvider = 'meta' | 'google';

const CONNECTABLE: Array<{
  key: string;
  provider: OAuthProvider;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    key: 'meta',
    provider: 'meta',
    name: 'Instagram + Facebook',
    description: 'Publish posts, run Meta ads, and read insights.',
    icon: Instagram,
  },
  {
    key: 'google',
    provider: 'google',
    name: 'Google Ads',
    description: 'Run search + display campaigns.',
    icon: Search,
  },
];

const COMING_SOON: Array<{
  key: string;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    key: 'linkedin',
    name: 'LinkedIn',
    description: 'Publish to your company page and read analytics.',
    icon: Linkedin,
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    description: 'Publish TikTok Business posts and run ads.',
    icon: Music2,
  },
];

function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'attention' | 'muted';
  children: React.ReactNode;
}) {
  const styles = {
    ok: 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300',
    attention: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
    muted: 'bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300',
  } as const;
  return (
    <span
      className={cn(
        'hidden sm:inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

export function ConnectionsList({ businessId, integrations }: ConnectionsListProps) {
  const [pending, setPending] = useState<OAuthProvider | null>(null);
  const statusByKey = new Map(integrations.map((i) => [i.key, i]));

  async function connect(provider: OAuthProvider) {
    if (!businessId) {
      toast.error('Finish onboarding first', {
        description: 'Complete your business profile, then connect your accounts here.',
      });
      return;
    }
    setPending(provider);
    try {
      const session = await getSession();
      const token = session?.access_token;
      if (!token) {
        toast.error('Please sign in again', { description: 'Your session has expired.' });
        setPending(null);
        return;
      }
      const url =
        `${API_URL}/webhook/oauth/${provider}/start` +
        `?businessId=${encodeURIComponent(businessId)}` +
        `&token=${encodeURIComponent(token)}`;
      window.location.href = url;
    } catch {
      toast.error('Could not start connection', { description: 'Try again in a moment.' });
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 px-5 py-4 flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 mt-0.5 text-accent-500 shrink-0" aria-hidden="true" />
        <div className="text-sm text-ink-700 dark:text-ink-100 leading-relaxed">
          Your tokens are stored encrypted (AES-256-GCM). You can disconnect any
          provider any time — the next attempt to use it will queue for re-auth
          instead of failing silently.
        </div>
      </div>

      {!businessId && (
        <div className="rounded-xl border border-amber-200/60 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/10 px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 mt-0.5 text-amber-600 dark:text-amber-300 shrink-0" aria-hidden="true" />
          <div className="text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
            Finish setting up your business profile first — then you can connect
            your accounts here.
          </div>
        </div>
      )}

      <ol className="space-y-3">
        {CONNECTABLE.map((p) => {
          const s = statusByKey.get(p.key);
          const connected = !!s?.connected;
          const degraded = s?.status === 'degraded';
          const isPending = pending === p.provider;
          return (
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
                <p className="text-sm text-ink-500 dark:text-ink-300">
                  {degraded && s?.detail ? s.detail : p.description}
                </p>
              </div>
              {connected ? (
                degraded ? (
                  <Pill tone="attention">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    Needs reconnect
                  </Pill>
                ) : (
                  <Pill tone="ok">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Connected
                  </Pill>
                )
              ) : (
                <Pill tone="muted">Not connected</Pill>
              )}
              <button
                type="button"
                onClick={() => connect(p.provider)}
                disabled={isPending || !businessId}
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:shadow-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Connecting…
                  </>
                ) : connected ? (
                  <>
                    Reconnect
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </>
                ) : (
                  <>
                    Connect
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </>
                )}
              </button>
            </li>
          );
        })}

        {COMING_SOON.map((p) => {
          const s = statusByKey.get(p.key);
          const connected = !!s?.connected;
          return (
            <li
              key={p.key}
              className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-5 py-5 flex items-center gap-4"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-400 dark:text-ink-500 shrink-0"
              >
                <p.icon className="h-5 w-5" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-ink-700 dark:text-ink-50 font-semibold">{p.name}</p>
                <p className="text-sm text-ink-500 dark:text-ink-300">{p.description}</p>
              </div>
              {connected ? (
                <Pill tone="ok">
                  <Check className="h-3 w-3" aria-hidden="true" />
                  Connected
                </Pill>
              ) : (
                <Pill tone="muted">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  Coming soon
                </Pill>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
