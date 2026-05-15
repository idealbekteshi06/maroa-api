import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Pause, Play, TrendingUp, TrendingDown, AlertTriangle, Clock, Zap, ChevronRight } from 'lucide-react';

export const metadata: Metadata = { title: 'Ads', robots: { index: false } };

type Verdict = 'scale' | 'maintain' | 'pause' | 'rework';

type Campaign = {
  id: string;
  name: string;
  client: string;
  platform: 'meta' | 'google' | 'tiktok';
  status: 'active' | 'paused' | 'review';
  daily_budget: number;
  spend_today: number;
  pacing_pct: number;
  ctr: number;
  cpa: number;
  roas: number;
  conversions_7d: number;
  verdict: Verdict;
  verdict_reason: string;
  alert?: 'pacing_high' | 'ctr_drop' | 'frequency_high';
};

const CAMPAIGNS: Campaign[] = [
  {
    id: 'c-1',
    name: 'Father\'s Day brunch — interest stack',
    client: 'Tirana Roastery',
    platform: 'meta',
    status: 'active',
    daily_budget: 35,
    spend_today: 32.20,
    pacing_pct: 92,
    ctr: 0.041,
    cpa: 4.20,
    roas: 4.8,
    conversions_7d: 38,
    verdict: 'scale',
    verdict_reason: 'ROAS 4.8x sustained 3 days. Recommend +50% budget by Sun.',
  },
  {
    id: 'c-2',
    name: 'Invisalign consultation — local intent',
    client: 'Smile Studio Dental',
    platform: 'google',
    status: 'active',
    daily_budget: 80,
    spend_today: 78.10,
    pacing_pct: 98,
    ctr: 0.052,
    cpa: 38,
    roas: 6.1,
    conversions_7d: 14,
    verdict: 'maintain',
    verdict_reason: 'On target. Letting it cook through learning phase.',
    alert: 'pacing_high',
  },
  {
    id: 'c-3',
    name: 'Emergency plumbing — 24/7',
    client: 'West Roxbury Plumbing',
    platform: 'google',
    status: 'review',
    daily_budget: 50,
    spend_today: 47,
    pacing_pct: 94,
    ctr: 0.018,
    cpa: 92,
    roas: 1.4,
    conversions_7d: 6,
    verdict: 'pause',
    verdict_reason: 'CPA $92 vs $45 target. Pausing in 24h unless creative refresh ships.',
    alert: 'ctr_drop',
  },
  {
    id: 'c-4',
    name: 'New patient — first cleaning',
    client: 'Smile Studio Dental',
    platform: 'meta',
    status: 'active',
    daily_budget: 25,
    spend_today: 21.30,
    pacing_pct: 85,
    ctr: 0.029,
    cpa: 42,
    roas: 3.1,
    conversions_7d: 7,
    verdict: 'rework',
    verdict_reason: 'Frequency 4.2 — audience fatigue. Refresh creative or expand audience.',
    alert: 'frequency_high',
  },
];

const VERDICT_STYLES: Record<Verdict, { label: string; tone: string; icon: typeof TrendingUp }> = {
  scale: { label: 'Scale', tone: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300 border-green-200/60 dark:border-green-500/20', icon: TrendingUp },
  maintain: { label: 'Maintain', tone: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200 border-ink-200/60 dark:border-ink-700', icon: Play },
  pause: { label: 'Pause', tone: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300 border-red-200/60 dark:border-red-500/20', icon: Pause },
  rework: { label: 'Rework', tone: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200/60 dark:border-amber-500/20', icon: TrendingDown },
};

const ALERTS: Record<NonNullable<Campaign['alert']>, string> = {
  pacing_high: 'Pacing 98% — may spend ahead',
  ctr_drop: 'CTR dropped 24% in last 48h',
  frequency_high: 'Frequency 4.2 — audience fatigue',
};

const PLATFORM_LABEL: Record<Campaign['platform'], string> = {
  meta: 'Meta',
  google: 'Google',
  tiktok: 'TikTok',
};

export default function AdsPage() {
  const totalSpendToday = CAMPAIGNS.reduce((s, c) => s + c.spend_today, 0);
  const totalBudget = CAMPAIGNS.reduce((s, c) => s + c.daily_budget, 0);
  const avgRoas = CAMPAIGNS.reduce((s, c) => s + c.roas, 0) / CAMPAIGNS.length;
  const needAction = CAMPAIGNS.filter((c) => c.verdict !== 'maintain').length;

  return (
    <>
      <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">Ads</h1>
          <p className="mt-2 text-ink-400 max-w-2xl">
            Daily audits, pacing alerts every 4 hours, and one-click apply on every recommendation.
            Maroa respects learning phases — no daily flip-flops, no premature optimization.
          </p>
        </div>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Spend today', value: `$${totalSpendToday.toFixed(0)}`, sub: `of $${totalBudget} budget` },
          { label: 'Avg ROAS (7d)', value: `${avgRoas.toFixed(1)}x`, sub: `across ${CAMPAIGNS.length} campaigns` },
          { label: 'Need action', value: `${needAction}`, sub: 'recommendations pending' },
          { label: 'Auto-actions 7d', value: '11', sub: 'shipped without you' },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-4"
          >
            <p className="text-xs uppercase tracking-wider text-ink-400">{k.label}</p>
            <p className="text-2xl font-semibold tracking-tight text-ink-700 dark:text-ink-100 mt-1">
              {k.value}
            </p>
            <p className="text-xs text-ink-400 mt-0.5">{k.sub}</p>
          </div>
        ))}
      </section>

      <h2 className="text-base font-semibold text-ink-700 dark:text-ink-100 mb-4">
        Active campaigns
      </h2>

      <div className="space-y-3">
        {CAMPAIGNS.map((c) => (
          <CampaignRow key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

function CampaignRow({ c }: { c: Campaign }) {
  const v = VERDICT_STYLES[c.verdict];
  const VIcon = v.icon;
  return (
    <article className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 hover:border-ink-300 dark:hover:border-ink-700 transition-colors overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 p-5 items-start">
        {/* Title + client */}
        <div className="lg:col-span-4 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 font-mono">
              {PLATFORM_LABEL[c.platform]}
            </span>
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${
              c.status === 'active'
                ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300'
                : c.status === 'paused'
                ? 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
            }`}>
              {c.status}
            </span>
          </div>
          <p className="text-sm font-semibold text-ink-700 dark:text-ink-100 truncate">{c.name}</p>
          <p className="text-xs text-ink-400 mt-0.5">{c.client}</p>
        </div>

        {/* Metrics */}
        <div className="lg:col-span-5 grid grid-cols-4 gap-3 text-xs">
          <Metric label="Spend / budget" value={`$${c.spend_today.toFixed(0)} / $${c.daily_budget}`} sub={`${c.pacing_pct}% pacing`} />
          <Metric label="CTR" value={`${(c.ctr * 100).toFixed(1)}%`} />
          <Metric label="CPA" value={`$${c.cpa.toFixed(0)}`} />
          <Metric label="ROAS 7d" value={`${c.roas.toFixed(1)}x`} good={c.roas >= 3} />
        </div>

        {/* Verdict */}
        <div className="lg:col-span-3 flex flex-col items-start lg:items-end gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-full border ${v.tone}`}>
            <VIcon className="h-3 w-3" />
            {v.label}
          </span>
          <Link
            href={`/ads/${c.id}`}
            className="text-xs font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400 inline-flex items-center gap-1"
          >
            Details
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Verdict reason + action */}
      <div className="px-5 pb-5 pt-1 border-t border-ink-100 dark:border-ink-800 flex items-start justify-between gap-4 flex-wrap">
        <p className="text-xs text-ink-700 dark:text-ink-200 max-w-2xl leading-relaxed">
          <span className="text-ink-400">Why · </span>
          {c.verdict_reason}
        </p>
        <div className="flex items-center gap-2">
          {c.alert && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" /> {ALERTS[c.alert]}
            </span>
          )}
          {c.verdict !== 'maintain' && (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:bg-ink-900 dark:hover:bg-ink-100 transition-colors"
              >
                <Zap className="h-3 w-3" /> Apply
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full text-ink-700 dark:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"
              >
                <Clock className="h-3 w-3" /> Snooze
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-400">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 ${good ? 'text-green-700 dark:text-green-400' : 'text-ink-700 dark:text-ink-100'}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-ink-400 mt-0.5">{sub}</p>}
    </div>
  );
}
