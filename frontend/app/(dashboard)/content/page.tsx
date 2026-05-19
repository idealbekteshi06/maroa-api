import type { Metadata } from 'next';
import { mockWorkspaceFeed } from '@/lib/mock/war-room';
import { fetchActiveWorkspaceFeedSSR } from '@/lib/api/war-room.server';
import { PageFrame } from '@/components/dashboard/page-frame';
import { ContentShell } from '@/components/dashboard/content/content-shell';

export const metadata: Metadata = {
  title: 'Content',
  robots: { index: false, follow: false },
};

/**
 * /content — Content Studio.
 *
 * The customer-facing view of what Maroa is shipping. NOT a draft Kanban
 * (the SMB-owner persona doesn't run a content board) — instead, three
 * health-style sections:
 *   1. Inbox callout (pending approvals)
 *   2. Working great (top creatives)
 *   3. Getting tired (decaying creatives that need a refresh)
 * Plus a "Draft something new" CTA wired to POST /api/content/generate.
 *
 * Data: shares the war-room SSR fetch so no second backend route needed.
 */
export default async function ContentPage() {
  const feed = (await fetchActiveWorkspaceFeedSSR()) ?? mockWorkspaceFeed;
  const businessId = feed.clients?.[0]?.business_id || null;
  return (
    <PageFrame
      eyebrow="Content"
      title="What Maroa is shipping."
      subtitle="Approve what’s pending, see what’s working, and ask me to draft something new."
    >
      <ContentShell feed={feed} businessId={businessId} />
    </PageFrame>
  );
}
