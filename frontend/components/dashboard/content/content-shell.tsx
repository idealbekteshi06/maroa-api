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
import { api, ApiError } from '@/lib/api/client';

/**
 * components/dashboard/content/content-shell.tsx
 * ---------------------------------------------------------------------------
 * Content Studio — the customer-facing view of what Maroa is shipping.
 *
 *   1. "Need your eyes" — pending approvals counter + link to /approvals
 *   2. "Working great" — top performers (top_creatives feed)
 *   3. "Getting tired" — decaying creatives that may need a refresh
 *
 * Plus a "Draft something new" CTA that hits POST /api/content/generate.
 * That endpoint is SYNCHRONOUS — it returns the generated piece — so we
 * render the result inline (the core content loop, verifiable end-to-end)
 * instead of a fire-and-forget toast. Compliance hard-blocks (422) surface
 * the flagged claims honestly rather than pretending the draft shipped.
 * ---------------------------------------------------------------------------
 */

/** Shape returned by POST /api/content/generate (server.js generateInstantContent). */
interface GeneratedContent {
  content_theme?: string;
  instagram_caption?: string;
  facebook_post?: string;
  instagram_story_text?: string;
  email_subject?: string;
  email_body?: string;
  blog_title?: string;
  image_url?: string;
  status?: string;
  compliance_warnings?: Array<{ reason?: string; rule?: string } | string>;
}

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
  const [result, setResult] = useState<GeneratedContent | null>(null);
  const [blockedClaims, setBlockedClaims] = useState<string[] | null>(null);

  function generateNew() {
    if (!businessId) {
      toast.error('Connect a business first', {
        description: 'Finish onboarding so I know what to draft for.',
      });
      return;
    }
    startGenerate(async () => {
      setResult(null);
      setBlockedClaims(null);
      try {
        const r = await api.post<{ ok: boolean; content: GeneratedContent }>(
          '/api/content/generate',
          { business_id: businessId },
        );
        setResult(r.content ?? null);
        toast.success('Draft ready', {
          description: 'Your new piece is below — review and approve it from your inbox.',
        });
      } catch (e) {
        // 422 = compliance hard-block. Show the flagged claims instead of a
        // generic failure — the draft exists but can't ship as-is.
        if (e instanceof ApiError && e.status === 422) {
          const body = (e.body ?? {}) as {
            violations?: Array<{ reason?: string; rule?: string; claim?: string } | string>;
          };
          const claims = (body.violations ?? [])
            .map((v) => (typeof v === 'string' ? v : v.reason || v.rule || v.claim))
            .filter((x): x is string => !!x);
          setBlockedClaims(claims.length ? claims : ['It tripped a compliance rule.']);
          toast.error('Draft needs changes before it can ship', {
            description: 'It tripped a compliance rule — details below.',
          });
        } else {
          toast.error('Could not draft new content', {
            description: errorMessage(e, 'Try again in a moment.'),
          });
        }
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
          Want me to draft something new?
        </h2>
        <p className="mt-2 text-ink-500 dark:text-ink-300">
          I&apos;ll pick the angle and channel — you approve when it&apos;s ready.
        </p>
        <Button
          variant="primary"
          size="lg"
          className="mt-5 disabled:opacity-60"
          onClick={generateNew}
          disabled={generating}
        >
          {generating ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
              Drafting…
            </>
          ) : (
            <>
              <PenSquare className="h-4 w-4" aria-hidden="true" />
              {result ? 'Draft another' : 'Draft something new'}
            </>
          )}
        </Button>

        {blockedClaims && <BlockedDraft claims={blockedClaims} />}
        {result && <GeneratedDraft content={result} />}
      </section>
    </div>
  );
}

/** Renders the synchronous result of POST /api/content/generate. */
function GeneratedDraft({ content }: { content: GeneratedContent }) {
  const blocks: Array<{ label: string; body: string }> = [];
  if (content.instagram_caption) blocks.push({ label: 'Instagram', body: content.instagram_caption });
  if (content.facebook_post) blocks.push({ label: 'Facebook', body: content.facebook_post });
  if (content.instagram_story_text) blocks.push({ label: 'Instagram story', body: content.instagram_story_text });
  if (content.email_subject || content.email_body) {
    blocks.push({
      label: 'Email',
      body: [content.email_subject, content.email_body].filter(Boolean).join('\n\n'),
    });
  }
  if (content.blog_title) blocks.push({ label: 'Blog', body: content.blog_title });

  const warnings = (content.compliance_warnings ?? [])
    .map((w) => (typeof w === 'string' ? w : w.reason || w.rule))
    .filter((x): x is string => !!x);

  return (
    <div className="mt-6 text-left rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-200/60 dark:border-ink-800 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-500" aria-hidden="true" />
        <p className="text-sm font-semibold text-ink-700 dark:text-ink-50">
          {content.content_theme || 'New draft'}
        </p>
      </div>

      {content.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={content.image_url}
          alt={content.content_theme || 'Generated creative'}
          className="w-full max-h-72 object-cover"
        />
      )}

      <div className="p-5 space-y-4">
        {blocks.length === 0 ? (
          <p className="text-sm text-ink-500 dark:text-ink-300">
            Draft saved to your library. Review and approve it from your inbox.
          </p>
        ) : (
          blocks.map((b) => (
            <div key={b.label}>
              <p className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-ink-300 font-medium">
                {b.label}
              </p>
              <p className="mt-1 text-sm text-ink-700 dark:text-ink-100 leading-relaxed whitespace-pre-line">
                {b.body}
              </p>
            </div>
          ))
        )}

        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-200/60 dark:border-amber-500/20 bg-amber-50/60 dark:bg-amber-500/10 px-4 py-3">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              Heads up before you publish
            </p>
            <ul className="mt-1.5 space-y-1 text-xs text-amber-800/90 dark:text-amber-200/80 list-disc pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-ink-400">
          Saved to your library — review &amp; approve from your inbox before it ships.
        </p>
      </div>
    </div>
  );
}

/** Compliance hard-block (422) — the draft exists but can't ship as-is. */
function BlockedDraft({ claims }: { claims: string[] }) {
  return (
    <div className="mt-6 text-left rounded-xl border border-red-200/60 dark:border-red-500/20 bg-red-50/60 dark:bg-red-500/10 px-5 py-4">
      <p className="text-sm font-semibold text-red-800 dark:text-red-300 flex items-center gap-1.5">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        This draft can&apos;t ship as written
      </p>
      <p className="mt-1 text-xs text-red-800/90 dark:text-red-200/80">
        It tripped a compliance rule. I&apos;ll need to rephrase these before it can go out:
      </p>
      <ul className="mt-2 space-y-1 text-xs text-red-800/90 dark:text-red-200/80 list-disc pl-5">
        {claims.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
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
