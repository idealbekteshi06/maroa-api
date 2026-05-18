import type { Metadata } from 'next';
import { ArrowRight, Check, Coffee, Inbox, Send, Zap, BarChart3, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HeroPreview } from '@/components/marketing/hero-preview';

export const metadata: Metadata = {
  title: 'AI marketing for freelancers — manage 5–20 clients, ship every day',
  description:
    'You\'re a marketing freelancer. Maroa runs the work — content, ads, CRO, reporting — across all your clients. You supervise, approve, and grow.',
  alternates: { canonical: '/for-freelancers' },
  openGraph: {
    title: 'Maroa for Freelancers — your AI marketing partner',
    description: 'Manage 5–20 clients without burning out.',
    url: '/for-freelancers',
  },
};

const REASONS = [
  {
    icon: Coffee,
    title: 'Stop dreading Mondays',
    body: 'Open your laptop, see this week\'s queue across every client, approve in two minutes. Maroa already drafted it.',
  },
  {
    icon: Inbox,
    title: 'One inbox for every client',
    body: 'Pending approvals, performance flags, competitor moves — all in one feed. No more switching tools or accounts.',
  },
  {
    icon: Send,
    title: 'Magic-link client approvals',
    body: 'Client gets a link. Approves from their phone. No Maroa account needed. No "can you send me a PDF?"',
  },
  {
    icon: Zap,
    title: 'Daily ad decisions',
    body: 'Maroa audits every campaign daily, suggests pause / scale / refresh, applies with one tap. You stay in control, not lost in details.',
  },
  {
    icon: BarChart3,
    title: 'Weekly client reports — auto-sent',
    body: 'Sunday night, a branded report lands in each client\'s inbox. Numbers, what worked, what Maroa changed. You look professional without doing the slides.',
  },
  {
    icon: Sparkles,
    title: 'Reasoning trace on every output',
    body: 'When a client asks "why this hook?" — show them the trace. Which framework, which audience stage, which corpus example. No black box.',
  },
];

const MATH = [
  { metric: 'Average freelancer revenue per client', value: '$800–1,500/mo', sub: '20 clients = $16k–30k MRR' },
  { metric: 'Maroa Agency cost', value: '$599/mo flat', sub: 'No per-client fees, up to 50 clients' },
  { metric: 'Time saved per client per week', value: '4–6 hours', sub: 'Content + reporting + approvals' },
  { metric: 'Time saved across 20 clients', value: '80–120 hours/month', sub: 'A second full-time you' },
];

export default function ForFreelancersPage() {
  return (
    <>
      {/* HERO */}
      <section className="relative grain pt-12 sm:pt-20 lg:pt-28">
        <div className="container">
          <div className="mx-auto max-w-4xl text-center animate-fade-in-up">
            <p className="text-eyebrow uppercase text-ink-400 mb-6">For marketing freelancers</p>
            <h1 className="text-display-xl text-ink-700 dark:text-ink-50">
              Run twenty clients
              <br className="hidden sm:block" />
              <span className="text-ink-400">like you ran two.</span>
            </h1>
            <p className="mt-6 text-xl sm:text-2xl text-ink-400 max-w-3xl mx-auto leading-relaxed text-pretty">
              Maroa drafts every post, audits every ad, writes every report, and sends magic-link
              approvals to your clients. You keep the relationship, the strategy, and the margin.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button href="/signup?plan=agency" variant="primary" size="xl">
                Get started
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button href="/features" variant="ghost" size="xl">
                See it work
              </Button>
            </div>
            <p className="mt-6 text-sm text-ink-400">
              Agency plan · $599/month · Monthly billing, USD · Cancel anytime
            </p>
          </div>
        </div>
        <div className="container mt-16 sm:mt-20">
          <HeroPreview />
        </div>
      </section>

      {/* WHY */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">What changes</p>
          <h2 className="text-display-md text-ink-700 dark:text-ink-50">
            The before/after for one freelancer.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl mx-auto">
          {REASONS.map((r) => (
            <div
              key={r.title}
              className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-6"
            >
              <div className="h-10 w-10 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center mb-4">
                <r.icon className="h-5 w-5 text-ink-700 dark:text-ink-100" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-semibold text-ink-700 dark:text-ink-100">{r.title}</h3>
              <p className="mt-2 text-sm text-ink-400 leading-relaxed">{r.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* MATH */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">The math</p>
          <h2 className="text-display-md text-ink-700 dark:text-ink-50">
            One Maroa subscription pays for itself by client #2.
          </h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-5xl mx-auto">
          {MATH.map((m) => (
            <div
              key={m.metric}
              className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-5"
            >
              <p className="text-xs uppercase tracking-wider text-ink-400 leading-snug">{m.metric}</p>
              <p className="text-2xl sm:text-3xl font-semibold tracking-tight text-ink-700 dark:text-ink-100 mt-2">
                {m.value}
              </p>
              <p className="text-xs text-ink-400 mt-1 leading-snug">{m.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CHECKLIST */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-8 sm:p-12">
          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-100 tracking-tight">
            What ships with the Agency plan
          </h2>
          <ul className="mt-6 space-y-3">
            {[
              'Up to 20 clients in one workspace',
              'All channels — Meta, Google, TikTok, LinkedIn, Pinterest, YouTube, email',
              'Daily ad audits + pacing alerts (every 4 hours)',
              'Weekly client scorecards — auto-sent, branded',
              'Brand voice + visual DNA per client (cached for Higgsfield)',
              'Compliance gates for 20 regulated industries',
              'Magic-link client approval inbox',
              'Reasoning trace on every output',
              'Multi-client calendar + content pipeline',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-3 text-ink-700 dark:text-ink-100 leading-relaxed"
              >
                <Check className="h-5 w-5 text-accent-500 flex-shrink-0 mt-0.5" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-10 flex flex-col sm:flex-row items-center gap-4">
            <Button href="/signup?plan=agency" variant="primary" size="lg">
              Get started
              <ArrowRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-ink-400">
              $599/month · Monthly billing, USD · Cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="container mt-32">
        <div className="rounded-xl bg-ink-700 dark:bg-ink-800 text-white px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display-md text-white">Add your first client in three minutes.</h2>
          <p className="mt-6 text-xl text-ink-100/80 max-w-2xl mx-auto leading-relaxed">
            See your content queue, your ads dashboard, and your approval inbox come to life —
            client #2 pays for the whole month.
          </p>
          <Button href="/signup?plan=agency" variant="accent" size="xl" className="mt-10">
            Get started
            <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      </section>
    </>
  );
}
