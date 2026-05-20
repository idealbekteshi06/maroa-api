'use client';

/**
 * components/dashboard/settings/slack-link-confirm.tsx
 * ---------------------------------------------------------------------------
 * The landing page for the /maroa link magic URL. Confirms which Slack
 * user is being linked, then POSTs /api/slack/link-complete on click. The
 * call carries the user's Supabase JWT (handled by apiFetch) — that's
 * what binds the Slack ID to this Maroa account.
 * ---------------------------------------------------------------------------
 */

import { useCallback, useState } from 'react';
import { CheckCircle2, Loader2, MessageCircle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api/client';

interface Props {
  slackUserId: string;
  slackTeamId: string | null;
}

export function SlackLinkConfirm({ slackUserId, slackTeamId }: Props) {
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);

  const onLink = useCallback(async () => {
    if (!slackUserId) {
      toast.error('Missing Slack user. Re-run /maroa link in Slack.');
      return;
    }
    setLinking(true);
    try {
      await apiFetch('/api/slack/link-complete', {
        method: 'POST',
        body: { slack_user_id: slackUserId, slack_team_id: slackTeamId },
      });
      setLinked(true);
      toast.success('Slack linked. You can now use /maroa from any channel.');
    } catch (err) {
      toast.error('Could not link Slack.', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLinking(false);
    }
  }, [slackUserId, slackTeamId]);

  if (!slackUserId) {
    return (
      <div className="rounded-xl border border-amber-300/70 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10 p-6 text-sm text-amber-900 dark:text-amber-100">
        Missing Slack user ID in the URL. Re-run <code>/maroa link</code> in Slack and click the
        fresh link.
      </div>
    );
  }

  if (linked) {
    return (
      <div className="rounded-xl border border-green-300/70 dark:border-green-500/50 bg-green-50 dark:bg-green-500/10 p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 mt-0.5 text-green-700 dark:text-green-300 shrink-0" />
          <div>
            <h2 className="text-sm font-semibold text-green-900 dark:text-green-100">
              Slack linked.
            </h2>
            <p className="mt-1 text-xs text-green-800 dark:text-green-200">
              Back in Slack you can now use <code>/maroa status</code>,{' '}
              <code>/maroa approvals</code>, and the approve/reject buttons.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 shadow-subtle">
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 shrink-0"
        >
          <MessageCircle className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-ink-700 dark:text-ink-50">
            Link Slack user <code className="font-mono text-sm">{slackUserId}</code>?
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            Maroa will use this mapping to verify <code>/maroa</code> commands. Only you can run
            commands against this Maroa account from Slack.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-ink-500 dark:text-ink-300">
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-ink-400 dark:text-ink-500" />
              All Slack requests are HMAC-verified before any action runs.
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-ink-400 dark:text-ink-500" />
              You can disconnect any time from this Settings page.
            </li>
          </ul>
          <div className="mt-4">
            <button
              type="button"
              onClick={onLink}
              disabled={linking}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
            >
              {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {linking ? 'Linking…' : 'Yes, link this Slack user'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
