'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  PenSquare,
  Sparkles,
  AlertCircle,
  ArrowRight,
  Inbox,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { friendlyTime } from '@/lib/translate';
import type { CreativeAsset, WorkspaceFeed } from '@/lib/types/war-room';
import { api } from '@/lib/api/client';

/**
 * components/dashboard/content/content-shell.tsx
 * ---------------------------------------------------------------------------
 * Content Studio — the customer-facing view of what Maroa is shipping.
 *
 * Three sections, in order of attention:
 *
 *   1. "Need your eyes" — pending approvals counter + link to /approvals
 *   2. "Working great" — top performers (top_creatives feed)
 *   3. "Getting tired" — decaying creatives that may need a refresh
 *
 * Plus a "Draft something new" CTA at the bottom that hits
 * POST /api/content/generate (fire-and-forget). A Sonner toast confirms.
 *
 * Built for the SMB-owner persona, not the operator: every metric is
 * framed in human terms ("seen 1,200 times" not "impressions: 1200").
 * ---------------------------------------------------------------------------
 */

function gatherCreatives(feed: WorkspaceFeed): {
  top: Array<CreativeAsset & { clientName: string }>;
  decaying: Array<CreativeAsset & { clientName: string }>;
} {
  const top: Array<CreativeAsset & { clientName: string }> = [];
  const decaying: Array<CreativeAsset & { clientName: string }> = [];
  for (const c of feed.clients) {
    const clientName = c.client?.client_name || 'Your business';
    for (const cr of c.top_creatives) top.push({ ...cr, clientName });
    for (const cr of c.decaying_creatives) decaying.push({ ...cr, clientName });
  }
  top.sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0));
  return { top: top.slice(0, 8), decaying: decaying.slice(0, 8) };
}

function pendingCount(feed: WorkspaceFeed): number {
  let n = 0;
  for (const c of feed.clients) {
    for (const d of c.recent_decisions) {
      if (d.required_approval && !d.executed && !d.refused) n += 1;
    }
  }
  return n;
}

function channelLabel(channel: string): string {
  const map: Record<string, string> = {
    instagram: 'Instagram',
    'instagram-post': 'Instagram post',
    'instagram-reels': 'Instagram reel',
    'instagram-stories': 'Instagram story',
    facebook: 'Facebook',
    'facebook-post': 'Facebook post',
    linkedin: 'LinkedIn',
    'linkedin-post': 'LinkedIn post',
    'meta-ads-image': 'Meta ad',
    'meta-ads-video': 'Meta video ad',
    'google-ads-search': 'Google search ad',
    'blog-seo': 'Blog post',
    'email-nurture': 'Email',
    tiktok: 'TikTok',
  };
  return map[channel] || channel.replace(/[-_]/g, ' ');
}

function friendlyMetrics(cr: CreativeAsset): string {
  const bits: string[] = [];
  if (cr.impressions > 0) {
    bits.push(`Seen ${formatBig(cr.impressions)} times`);
  }
  if (cr.clicks > 0) {
    bits.push(`${formatBig(cr.clicks)} clicks`);
  }
  if (cr.conversions > 0) {
    bits.push(`${cr.conversions} ${cr.conversions === 1 ? 'lead' : 'leads'}`);
  }
  return bits.join(' · ') || 'Just started running';
}

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

interface Props {
  feed: WorkspaceFeed;
  businessId?: string | null;
}

export function ContentShell({ feed, businessId }: Props) {
  const { top, decaying } = useMemo(() => gatherCreatives(feed), [feed]);
  const pending = pendingCount(feed);
  const [generating, startGenerate] = useTransition();
  const [generated, setGenerated] = useState(false);

  function generateNew() {
    if (!businessId) {
      toast.error('Connect a business first', {
        description: 'Finish onboarding so I know what to draft for.',
      });
      return;
    }
    startGenerate(async () => {
      try {
        await api.post('/api/content/generate', { business_id: businessId });
        setGenerated(true);
        toast.success('Drafting a new piece', {
          description: "I'll surface it in your inbox in a minute or two.",
        });
      } catch (e) {
        toast.error('Could not start a new draft', {
          description: errorMessage(e, 'Try again in a moment.'),
        });
      }
    });
  }

  return (
    <div className="space-y-8">
      {/* Pending approvals callout */}
      <Link
        href="/dashboard/approvals"
        className={cn(
          'group block rounded-xl border bg-white dark:bg-ink-900 shadow-subtle hover:shadow-card transition-shadow',
          pending > 0
            ? 'border-accent-200/60 dark:border-accent-900/40'
            : 'border-ink-200/60 dark:border-ink-800',
        )}
      >
        <div className="px-6 sm:px-8 py-6 flex items-start gap-4">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-xl shrink-0',
              pending > 0
                ? 'bg-accent-50 dark:bg-accent-900/30 text-accent-500'
                : 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400',
            )}
          >
            <Inbox className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Inbox</p>
            <h2 className="mt-1 text-xl text-ink-700 dark:text-ink-50 font-semibold leading-snug">
              {pending > 0
                ? `${pending} ${pending === 1 ? 'piece' : 'pieces'} waiting on your approval`
                : 'Inbox clear — nothing waiting.'}
            </h2>
            <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
              {pending > 0
                ? 'Tap to review — usually under a minute.'
                : "I'll surface anything new here as soon as I draft it."}
            </p>
          </div>
          <ArrowRight
            className="h-5 w-5 text-ink-400 self-center transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </div>
      </Link>

      {/* Top performers */}
      <section aria-labelledby="top-performers" className="space-y-4">
        <header className="flex items-baseline justify-between">
          <div>
            <h2
              id="top-performers"
              className="text-eyebrow uppercase text-ink-500 dark:text-ink-300"
            >
              Working great
            </h2>
            <p className="mt-1 text-lg text-ink-700 dark:text-ink-50 font-medium">
              {top.length > 0
                ? `${top.length} ${top.length === 1 ? 'piece is' : 'pieces are'} performing above average.`
                : "Nothing has had time to perform yet."}
            </p>
          </div>
        </header>
        {top.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Performance data coming."
            description="Once your ads or posts have been live for a couple of days, the winners will show up here."
          />
        ) : (
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {top.map((cr) => (
              <CreativeRow key={cr.id} cr={cr} tone="good" />
            ))}
          </ol>
        )}
      </section>

      {/* Decaying */}
      {decaying.length > 0 && (
        <section aria-labelledby="getting-tired" className="space-y-4">
          <header>
            <h2
              id="getting-tired"
              className="text-eyebrow uppercase text-ink-500 dark:text-ink-300"
            >
              Getting tired
            </h2>
            <p className="mt-1 text-lg text-ink-700 dark:text-ink-50 font-medium">
              {decaying.length} {decaying.length === 1 ? 'piece' : 'pieces'} could use a refresh.
            </p>
            <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
              I’ll suggest replacements in your inbox when it’s time.
            </p>
          </header>
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {decaying.map((cr) => (
              <CreativeRow key={cr.id} cr={cr} tone="watch" />
            ))}
          </ol>
        </section>
      )}

      {/* Generate-new CTA */}
      <section
        aria-labelledby="generate-new"
        className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 p-6 sm:p-8 text-center"
      >
        <h2
          id="generate-new"
          className="text-xl text-ink-700 dark:text-ink-50 font-semibold"
        >
          {generated ? 'New draft on the way' : 'Want me to draft something new?'}
        </h2>
        <p className="mt-2 text-ink-500 dark:text-ink-300">
          {generated
            ? "I'll surface it in your inbox in a minute or two."
            : "I'll pick the angle and channel — you approve when it's ready."}
        </p>
        <Button
          variant="primary"
          size="lg"
          className="mt-5 disabled:opacity-60"
          onClick={generateNew}
          disabled={generating || generated}
        >
          {generating ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              Drafting…
            </>
          ) : (
            <>
              <PenSquare className="h-4 w-4" aria-hidden="true" />
              {generated ? 'Drafting in progress' : 'Draft something new'}
            </>
          )}
        </Button>
      </section>
    </div>
  );
}

function CreativeRow({
  cr,
  tone,
}: {
  cr: CreativeAsset & { clientName: string };
  tone: 'good' | 'watch';
}) {
  return (
    <li className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-ink-300 font-medium">
          {channelLabel(cr.channel)}
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="text-[10px] text-ink-500 dark:text-ink-300">{cr.clientName}</span>
        {tone === 'watch' && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-3 w-3" aria-hidden="true" /> Fading
          </span>
        )}
      </div>
      {cr.cta_text && (
        <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug font-medium line-clamp-2">
          “{cr.cta_text}”
        </p>
      )}
      <p className="mt-2 text-xs text-ink-500 dark:text-ink-300">{friendlyMetrics(cr)}</p>
      <p className="mt-1 text-[11px] text-ink-400">Live {friendlyTime(cr.created_at)}</p>
    </li>
  );
}
