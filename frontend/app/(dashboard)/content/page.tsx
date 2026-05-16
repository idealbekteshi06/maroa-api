import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Calendar, Plus, Eye, Sparkles, AlertTriangle, CheckCircle2, Send } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Content',
  robots: { index: false, follow: false },
};

/**
 * Content Studio — Kanban-style queue.
 *
 * Four columns: Drafts (Maroa just generated) · Pending (awaiting client
 * approval) · Scheduled (approved, queued to publish) · Published.
 * Each card shows the channel, hook type, scheduled time, and a
 * reasoning-trace summary so the user sees WHY this was drafted.
 *
 * Mock data ships now; swap to the real API once content/list lands.
 */

type ContentStatus = 'draft' | 'pending' | 'scheduled' | 'published';

type ContentItem = {
  id: string;
  title: string;
  channel: string;
  status: ContentStatus;
  client: string;
  scheduled?: string;
  hookType?: string;
  framework?: string;
  hasIssue?: 'low_voice_match' | 'pacing_warning';
};

const ITEMS: ContentItem[] = [
  { id: '1', title: 'Father\'s Day weekend brunch — special menu drop', channel: 'instagram-post', status: 'pending', client: 'Tirana Roastery', scheduled: 'Sun · 09:00', hookType: 'social_proof', framework: 'AIDA' },
  { id: '2', title: 'Why your dental hygienist is your best friend', channel: 'linkedin-post', status: 'pending', client: 'Smile Studio Dental', scheduled: 'Tue · 12:00', hookType: 'curiosity', framework: 'StoryBrand' },
  { id: '3', title: 'Free emergency call within 30 minutes', channel: 'meta-ads-image', status: 'pending', client: 'West Roxbury Plumbing', scheduled: 'Now', hookType: 'scarcity', framework: 'Direct response', hasIssue: 'pacing_warning' },
  { id: '4', title: 'Espresso 101 — what makes a great roast', channel: 'blog-seo', status: 'draft', client: 'Tirana Roastery', hookType: 'authority', framework: 'SkyScraper' },
  { id: '5', title: 'Mom, can I get Invisalign?', channel: 'instagram-reels', status: 'draft', client: 'Smile Studio Dental', hookType: 'pattern_interrupt', framework: 'Sugarman 30 triggers', hasIssue: 'low_voice_match' },
  { id: '6', title: 'July 4 hours + special — closed Mon', channel: 'facebook-post', status: 'scheduled', client: 'Tirana Roastery', scheduled: 'Jul 3 · 18:00', hookType: 'reciprocity', framework: 'Cialdini reciprocity' },
  { id: '7', title: 'Customer story — Maria saved 80% on root canal', channel: 'email-nurture', status: 'scheduled', client: 'Smile Studio Dental', scheduled: 'Fri · 07:00', hookType: 'social_proof', framework: 'PAS' },
  { id: '8', title: 'Same-day appointments now available', channel: 'google-ads-search', status: 'published', client: 'Smile Studio Dental', scheduled: 'Mon · 09:00', hookType: 'reciprocity', framework: 'Direct response' },
  { id: '9', title: 'Latte art Saturday — class signup', channel: 'instagram-stories', status: 'published', client: 'Tirana Roastery', scheduled: 'Today · 11:30', hookType: 'aspiration', framework: 'StoryBrand' },
];

const COLUMNS: { id: ContentStatus; label: string; tone: string; icon: typeof Eye }[] = [
  { id: 'draft', label: 'Drafts', tone: 'text-ink-400', icon: Sparkles },
  { id: 'pending', label: 'Awaiting approval', tone: 'text-amber-700 dark:text-amber-400', icon: Eye },
  { id: 'scheduled', label: 'Scheduled', tone: 'text-accent-500', icon: Calendar },
  { id: 'published', label: 'Published', tone: 'text-green-700 dark:text-green-400', icon: CheckCircle2 },
];

const ISSUE_TEXT: Record<NonNullable<ContentItem['hasIssue']>, string> = {
  low_voice_match: 'Brand-voice match below 0.7 — review tone',
  pacing_warning: 'Daily budget at 92% — pacing alert',
};

export default function ContentPage() {
  return (
    <>
      <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
            Content Studio
          </h1>
          <p className="mt-2 text-ink-400 max-w-2xl">
            Everything Maroa drafts, queues, and ships — across every client and channel. Approve in
            one tap, edit inline, or send a magic-link for the client to approve from their phone.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/content/calendar"
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-ink-700 dark:text-ink-100 border border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            <Calendar className="h-4 w-4" /> Calendar
          </Link>
          <Link
            href="/content/new"
            className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-900 dark:hover:bg-ink-100 transition-colors"
          >
            <Plus className="h-4 w-4" /> New brief
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const items = ITEMS.filter((i) => i.status === col.id);
          return (
            <section
              key={col.id}
              aria-labelledby={`col-${col.id}`}
              className="rounded-xl bg-ink-50/60 dark:bg-ink-900/40 border border-ink-200/60 dark:border-ink-800 p-3"
            >
              <header className="flex items-center gap-2 px-2 py-2">
                <col.icon className={`h-4 w-4 ${col.tone}`} />
                <h2 id={`col-${col.id}`} className={`text-sm font-semibold ${col.tone}`}>
                  {col.label}
                </h2>
                <span className="ml-auto text-xs text-ink-400">{items.length}</span>
              </header>
              <div className="space-y-2 mt-2">
                {items.map((it) => (
                  <ContentCard key={it.id} item={it} />
                ))}
                {items.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-ink-400">Nothing here.</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function ContentCard({ item }: { item: ContentItem }) {
  return (
    <Link
      href={`/content/${item.id}`}
      className="block rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 hover:border-ink-300 dark:hover:border-ink-600 p-3 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-ink-400 font-mono">
          {item.channel}
        </span>
        {item.scheduled && (
          <span className="text-[10px] text-ink-400 font-mono">{item.scheduled}</span>
        )}
      </div>

      <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug font-medium line-clamp-2">
        {item.title}
      </p>

      <p className="mt-2 text-[11px] text-ink-400">{item.client}</p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {item.hookType && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200">
              {item.hookType.replace('_', ' ')}
            </span>
          )}
          {item.framework && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-50 dark:bg-accent-500/10 text-accent-700 dark:text-accent-300">
              {item.framework}
            </span>
          )}
        </div>

        {item.status === 'pending' && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-ink-700 dark:text-ink-100">
            <Send className="h-3 w-3" /> Approve
            <ArrowRight className="h-2.5 w-2.5" />
          </span>
        )}
      </div>

      {item.hasIssue && (
        <p className="mt-2 inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" /> {ISSUE_TEXT[item.hasIssue]}
        </p>
      )}
    </Link>
  );
}
