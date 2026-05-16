import { ArrowRight, AlertCircle, Sparkles, ShieldAlert, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import type { DecisionLogRow } from '@/lib/types/war-room';
import { DecisionActions } from './decision-actions';

const BAND_STYLES: Record<DecisionLogRow['auto_safe_band'], string> = {
  green: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300 border-green-200/60 dark:border-green-500/20',
  yellow: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200/60 dark:border-amber-500/20',
  red: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300 border-red-200/60 dark:border-red-500/20',
};

const AGENT_ICONS: Record<string, typeof Sparkles> = {
  'ad-optimizer': TrendingUp,
  'competitor-watch': AlertCircle,
  'content-generator': Sparkles,
  'agency-pipeline': Sparkles,
  cro: TrendingUp,
  voc: Sparkles,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function PriorityCard({
  decision,
  businessName,
  workspaceId,
}: {
  decision: DecisionLogRow;
  businessName?: string;
  workspaceId: string;
}) {
  const Icon = AGENT_ICONS[decision.agent_name] || Sparkles;
  const band = BAND_STYLES[decision.auto_safe_band];

  return (
    <article className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 hover:border-ink-300 dark:hover:border-ink-600 transition-colors p-5">
      <div className="flex items-start gap-4">
        <div className={cn('h-10 w-10 rounded-xl flex items-center justify-center border', band)}>
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-ink-400">
              {decision.agent_name.replace(/-/g, ' ')}
            </p>
            {businessName && (
              <>
                <span className="text-ink-300 dark:text-ink-600">·</span>
                <p className="text-xs text-ink-400 truncate">{businessName}</p>
              </>
            )}
            <span className="ml-auto text-xs text-ink-400 font-mono">{timeAgo(decision.created_at)}</span>
          </div>

          <p className="text-ink-700 dark:text-ink-100 leading-snug">{decision.recommendation_text}</p>

          {(decision.expected_upside_text || decision.risk_text) && (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              {decision.expected_upside_text && (
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-ink-400">Upside</dt>
                  <dd className="text-ink-700 dark:text-ink-200 font-medium">{decision.expected_upside_text}</dd>
                </div>
              )}
              {decision.risk_text && (
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-ink-400">Risk</dt>
                  <dd className="text-ink-700 dark:text-ink-200 font-medium">{decision.risk_text}</dd>
                </div>
              )}
              <div className="flex items-baseline gap-1.5">
                <dt className="text-ink-400">Confidence</dt>
                <dd className="text-ink-700 dark:text-ink-200 font-medium">{Math.round(decision.confidence * 100)}%</dd>
              </div>
              {decision.cost_usd > 0 && (
                <div className="flex items-baseline gap-1.5">
                  <dt className="text-ink-400">Cost</dt>
                  <dd className="text-ink-700 dark:text-ink-200 font-medium">${decision.cost_usd.toFixed(2)}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="mt-4">
            {decision.refused ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">
                <ShieldAlert className="h-3 w-3" />
                Refused — {decision.refusal_reason}
              </span>
            ) : decision.required_approval ? (
              <DecisionActions
                workspaceId={workspaceId}
                decisionId={decision.id}
                detailHref={`/dashboard/decisions/${decision.id}`}
              />
            ) : decision.executed ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Auto-executed
              </span>
            ) : (
              <Link
                href={`/dashboard/decisions/${decision.id}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400"
              >
                See details
                <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
