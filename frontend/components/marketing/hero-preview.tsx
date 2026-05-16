import { Sparkles, AlertCircle, ShieldCheck, TrendingUp, Inbox } from 'lucide-react';

/**
 * HeroPreview — the marketing-home hero visual.
 *
 * Renders a faithful mini-War-Room INSIDE an Apple-style window chrome:
 * traffic-light dots, title bar, sidebar, content area with a priority
 * card and a KPI strip. Designed to convey "this is what the real product
 * looks like" without committing to a screenshot that goes stale.
 *
 * All composed in Tailwind — no images, no SVG export, scales cleanly,
 * dark-mode aware. Reduced-motion safe.
 */
export function HeroPreview() {
  return (
    <div
      className="mx-auto max-w-5xl rounded-xl shadow-lifted border border-ink-200/60 dark:border-ink-700/60 overflow-hidden bg-white dark:bg-ink-900"
      aria-label="Maroa War Room preview"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-2 px-4 py-3 bg-ink-50 dark:bg-ink-950/60 border-b border-ink-200/60 dark:border-ink-800">
        <span className="h-3 w-3 rounded-full bg-red-400/80" aria-hidden="true" />
        <span className="h-3 w-3 rounded-full bg-amber-400/80" aria-hidden="true" />
        <span className="h-3 w-3 rounded-full bg-green-400/80" aria-hidden="true" />
        <div className="mx-auto flex items-center gap-2 text-xs text-ink-400 font-mono">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          app.maroa.ai/dashboard
        </div>
      </div>

      {/* Inner app frame */}
      <div className="flex h-[420px] sm:h-[480px]">
        {/* Sidebar */}
        <div className="hidden sm:flex flex-col w-48 bg-ink-50/60 dark:bg-ink-950/40 border-r border-ink-200/60 dark:border-ink-800 p-4">
          <div className="flex items-center gap-2 mb-6 px-1">
            <span className="h-6 w-6 rounded-md bg-ink-700 dark:bg-white flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  className="text-white dark:text-ink-900"
                />
                <circle cx="12" cy="12" r="4" fill="currentColor" className="text-white dark:text-ink-900" />
              </svg>
            </span>
            <span className="text-sm font-semibold tracking-tight text-ink-700 dark:text-ink-100">Maroa</span>
          </div>
          <nav className="space-y-1">
            {[
              { label: 'War Room', active: true },
              { label: 'Content', active: false },
              { label: 'Ads', active: false },
              { label: 'Clients', active: false },
              { label: 'Settings', active: false },
            ].map((i) => (
              <div
                key={i.label}
                className={`text-xs px-3 py-1.5 rounded-lg ${
                  i.active
                    ? 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 font-medium'
                    : 'text-ink-400'
                }`}
              >
                {i.label}
              </div>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 p-5 sm:p-6 overflow-hidden">
          {/* Header */}
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-wider text-ink-400">Today</p>
            <h3 className="text-lg sm:text-xl font-semibold text-ink-700 dark:text-ink-100 mt-0.5 tracking-tight">
              War Room — 3 clients, 2 need approval
            </h3>
          </div>

          {/* KPI strip */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-5">
            {[
              { label: 'Live creatives', value: '94', tone: 'default' },
              { label: 'Pending', value: '2', tone: 'warn' },
              { label: 'Tests running', value: '1', tone: 'default' },
              { label: 'Refusals 7d', value: '1', tone: 'default' },
            ].map((k) => (
              <div
                key={k.label}
                className="rounded-lg border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950/40 p-2.5"
              >
                <p className="text-[10px] uppercase tracking-wider text-ink-400">{k.label}</p>
                <p
                  className={`text-base sm:text-lg font-semibold tracking-tight mt-0.5 ${
                    k.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-ink-700 dark:text-ink-100'
                  }`}
                >
                  {k.value}
                </p>
              </div>
            ))}
          </div>

          {/* Priority card — the hero visual: a real Maroa decision */}
          <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950/40 p-4">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200/60 dark:border-green-500/20 flex items-center justify-center flex-shrink-0">
                <TrendingUp className="h-4 w-4 text-green-700 dark:text-green-300" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 text-[10px] uppercase tracking-wider">
                  <span className="text-ink-400">ad optimizer</span>
                  <span className="text-ink-300">·</span>
                  <span className="text-ink-400">Tirana Roastery</span>
                  <span className="ml-auto font-mono text-ink-400">2h ago</span>
                </div>
                <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug">
                  CTR on Meta image ad dropped 31% over 4 days. Refresh creative, not budget.
                </p>
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px]">
                  <div>
                    <dt className="inline text-ink-400">Upside · </dt>
                    <dd className="inline text-ink-700 dark:text-ink-200 font-medium">+15% CTR</dd>
                  </div>
                  <div>
                    <dt className="inline text-ink-400">Confidence · </dt>
                    <dd className="inline text-ink-700 dark:text-ink-200 font-medium">84%</dd>
                  </div>
                  <div>
                    <dt className="inline text-ink-400">Cost · </dt>
                    <dd className="inline text-ink-700 dark:text-ink-200 font-medium">$0.30</dd>
                  </div>
                </dl>
                <div className="mt-3 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-700 dark:text-green-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    Auto-executed
                  </span>
                  <span className="text-ink-300">·</span>
                  <span className="text-[10px] text-ink-400">no human action needed</span>
                </div>
              </div>
            </div>
          </div>

          {/* Two more priority items — compact */}
          <div className="mt-2 space-y-2">
            {[
              {
                icon: AlertCircle,
                tone: 'amber',
                agent: 'competitor watch',
                business: 'Smile Studio Dental',
                text: 'Competitor dropped Invisalign price by $400. Counter with installment offer?',
                action: 'Review',
              },
              {
                icon: ShieldCheck,
                tone: 'red',
                agent: 'compliance gate',
                business: 'Acme Supplements',
                text: 'REFUSED: banned health claim "cures fatigue". Substituted compliant variant.',
                action: 'View trace',
              },
            ].map((p) => {
              const Icon = p.icon;
              return (
                <div
                  key={p.business}
                  className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-950/40 p-3 flex items-start gap-3"
                >
                  <div
                    className={`h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0 border ${
                      p.tone === 'amber'
                        ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-200/60 dark:border-amber-500/20'
                        : 'bg-red-50 dark:bg-red-500/10 border-red-200/60 dark:border-red-500/20'
                    }`}
                  >
                    <Icon
                      className={`h-3.5 w-3.5 ${
                        p.tone === 'amber'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-red-700 dark:text-red-300'
                      }`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5 text-[10px] uppercase tracking-wider">
                      <span className="text-ink-400">{p.agent}</span>
                      <span className="text-ink-300">·</span>
                      <span className="text-ink-400">{p.business}</span>
                    </div>
                    <p className="text-xs sm:text-sm text-ink-700 dark:text-ink-100 leading-snug truncate">
                      {p.text}
                    </p>
                  </div>
                  <span className="text-[10px] px-2 py-1 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 font-medium flex-shrink-0">
                    {p.action}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right rail — visible md+ */}
        <div className="hidden md:flex flex-col w-44 lg:w-52 bg-ink-50/40 dark:bg-ink-950/20 border-l border-ink-200/60 dark:border-ink-800 p-4">
          <p className="text-[10px] uppercase tracking-wider text-ink-400 flex items-center gap-1.5 mb-3">
            <Inbox className="h-3 w-3" />
            Approval inbox
          </p>
          <div className="space-y-2 mb-6">
            {[
              { client: 'Tirana Roastery', what: 'IG captions × 5' },
              { client: 'Smile Studio', what: 'Counter-offer copy' },
            ].map((a) => (
              <div
                key={a.client}
                className="rounded-lg border border-amber-200/60 dark:border-amber-500/20 bg-white dark:bg-ink-950/40 p-2"
              >
                <p className="text-[10px] text-ink-400">{a.client}</p>
                <p className="text-xs text-ink-700 dark:text-ink-100 truncate">{a.what}</p>
              </div>
            ))}
          </div>

          <p className="text-[10px] uppercase tracking-wider text-ink-400 flex items-center gap-1.5 mb-3">
            <Sparkles className="h-3 w-3" />
            Just shipped
          </p>
          <ol className="space-y-2.5 text-[10px] text-ink-700 dark:text-ink-200">
            <li className="leading-snug">
              <span className="text-ink-400">ad optimizer · </span>
              Refreshed Meta creative
            </li>
            <li className="leading-snug">
              <span className="text-ink-400">cro · </span>
              Hero rewrite shipped to West Roxbury
            </li>
            <li className="leading-snug">
              <span className="text-ink-400">content · </span>
              Scheduled 5 IG posts
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
