import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, Sparkles, Zap, Shield, BarChart3, Globe2, Users, Briefcase, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { HeroPreview } from '@/components/marketing/hero-preview';

export const metadata: Metadata = {
  title: 'AI marketing for freelancers, agencies & small businesses',
  description:
    'Maroa runs the whole marketing machine — content, ads, CRO, SEO, reporting — across your clients or your business. Daily decisions, full reasoning trace, compliance built in.',
  alternates: { canonical: '/' },
};

const MODES = [
  {
    icon: Store,
    label: 'Solo business',
    body: 'One business, autopilot. Approve a week of content in two minutes Monday morning.',
    href: '/features',
  },
  {
    icon: Briefcase,
    label: 'Freelancer',
    body: '5–20 clients, one inbox. Generate, send for approval, publish — no client babysitting.',
    href: '/for-freelancers',
  },
  {
    icon: Users,
    label: 'Agency',
    body: 'Workspaces, roles, white-label reports, multi-client calendar. Scale without hiring.',
    href: '/for-agencies',
  },
  {
    icon: Shield,
    label: 'Enterprise',
    body: 'Brand governance, SSO, audit logs, custom model routing. Same engine, regulated controls.',
    href: '/contact',
  },
];

const SOCIAL_PROOF = [
  { number: '28', label: 'Proven copywriting frameworks' },
  { number: '20', label: 'Industry compliance rulesets' },
  { number: '35+', label: 'Native channel formats' },
  { number: '<2 min', label: 'From idea to scheduled post' },
];

const FEATURES = [
  {
    icon: Sparkles,
    title: 'Industry-aware from day one',
    description:
      'No blank page. Maroa knows what works in your industry before you write a word — dental, café, plumber, SaaS, retail. 50+ verticals.',
  },
  {
    icon: Shield,
    title: 'Compliance built in',
    description:
      'Auto-blocks claims that violate FDA, FTC, FCA, or platform policy. Healthcare, finance, alcohol, supplements — protected by design.',
  },
  {
    icon: Zap,
    title: 'Every channel, native',
    description:
      'Reels are not LinkedIn. Email is not SMS. Maroa adapts every post for the channel it ships to — hook patterns, length, format, tone.',
  },
  {
    icon: BarChart3,
    title: 'Ads that audit themselves',
    description:
      'Daily audits on every campaign. Pacing alerts every 4 hours. Pause / scale / A-B test recommendations — one click to apply.',
  },
  {
    icon: Globe2,
    title: 'Speaks your customer’s language',
    description:
      'Native fluency in 18+ languages. Adapts to local culture, holidays, and tone — no translated-feeling English.',
  },
  {
    icon: Check,
    title: 'Shows you why',
    description:
      'Every piece comes with a reasoning trace — which framework, which audience stage, which constraints checked. No AI black box.',
  },
];

const PROOF_QUOTES = [
  {
    quote:
      'It writes ad copy in my industry better than the agency I was paying $2k/month. And it tells me why it chose each line.',
    author: 'Owner — dental practice, Boston',
  },
  {
    quote: 'The compliance check caught a claim my last freelancer ran for three months without realizing.',
    author: 'Owner — supplements brand, Austin',
  },
  {
    quote: 'I stopped dreading Mondays. The week’s content is just there, on-brand, ready to approve.',
    author: 'Owner — café, Tirana',
  },
];

export default function LandingPage() {
  return (
    <>
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative grain pt-12 sm:pt-20 lg:pt-28">
        <div className="container">
          <div className="mx-auto max-w-4xl text-center animate-fade-in-up">
            <p className="text-eyebrow uppercase text-ink-400 mb-6">
              The marketing operating system
            </p>
            <h1 className="text-display-xl text-ink-700 dark:text-ink-50">
              Your AI marketing team.
              <br className="hidden sm:block" />
              <span className="text-ink-400">For every client.</span>
            </h1>
            <p className="mt-6 text-xl sm:text-2xl text-ink-400 max-w-2xl mx-auto leading-relaxed text-pretty">
              Maroa runs the whole machine — content, ads, CRO, SEO, reporting — across
              your clients or your own business. Daily decisions. Full reasoning trace.
              Compliance built in.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button href="/signup" variant="primary" size="xl">
                Start free
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button href="/features" variant="ghost" size="xl">
                See how it works
              </Button>
            </div>
            <p className="mt-6 text-sm text-ink-400">
              7-day free trial · No credit card · Cancel anytime
            </p>
          </div>
        </div>

        {/* Hero product preview — rendered, not a placeholder. */}
        <div className="container mt-16 sm:mt-20">
          <HeroPreview />
        </div>
      </section>

      {/* MODE STRIP — who this is for ───────────────────────────────────── */}
      <section className="container mt-24 sm:mt-32">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Who Maroa is for</p>
          <h2 className="text-display-md text-ink-700 dark:text-ink-50">
            One engine. Four ways to run it.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
          {MODES.map((m) => (
            <Link
              key={m.label}
              href={m.href}
              className="block rounded-2xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 hover:border-accent-500 hover:shadow-card transition-all"
            >
              <div className="h-10 w-10 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center mb-4">
                <m.icon className="h-5 w-5 text-ink-700 dark:text-ink-100" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-semibold text-ink-700 dark:text-ink-100">{m.label}</h3>
              <p className="mt-2 text-sm text-ink-400 leading-relaxed">{m.body}</p>
              <p className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-accent-500">
                See how
                <ArrowRight className="h-3 w-3" />
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* SOCIAL PROOF / NUMBERS ───────────────────────────────────────────── */}
      <section className="container mt-32">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 max-w-4xl mx-auto">
          {SOCIAL_PROOF.map((item) => (
            <div key={item.label} className="text-center">
              <p className="text-4xl sm:text-5xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">
                {item.number}
              </p>
              <p className="mt-2 text-sm text-ink-400 leading-snug">{item.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES ─────────────────────────────────────────────────────────── */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto text-center mb-16">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">
            Everything a small business marketing team would do
          </p>
          <h2 className="text-display-lg text-ink-700">
            More thorough than any single specialist.
            <br />
            <span className="text-ink-400">Every time.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="p-2">
              <CardContent>
                <div className="h-12 w-12 rounded-2xl bg-ink-100 flex items-center justify-center mb-5">
                  <feature.icon className="h-6 w-6 text-ink-700" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold text-ink-700 mb-2">{feature.title}</h3>
                <p className="text-ink-400 leading-relaxed">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS — 3 steps ───────────────────────────────────────────── */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto text-center mb-16">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">How it works</p>
          <h2 className="text-display-lg text-ink-700">Three minutes to set up.</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {[
            {
              step: '01',
              title: 'Tell us your business',
              body: 'Industry, location, audience. Connect Meta and Google ads.',
            },
            {
              step: '02',
              title: 'Approve your first week',
              body: 'Maroa drafts five days of content, on-brand, on-channel. Edit or one-click approve.',
            },
            {
              step: '03',
              title: 'Watch what works',
              body: 'Maroa publishes, audits ads daily, alerts you on pacing, suggests changes you apply with one tap.',
            },
          ].map((s) => (
            <div key={s.step}>
              <p className="font-mono text-ink-400 text-sm tracking-wider">{s.step}</p>
              <h3 className="mt-3 text-xl font-semibold text-ink-700">{s.title}</h3>
              <p className="mt-3 text-ink-400 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* QUOTES ───────────────────────────────────────────────────────────── */}
      <section className="container mt-32">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {PROOF_QUOTES.map((q) => (
            <Card key={q.author} className="bg-ink-50/40 border-ink-200/40">
              <CardContent>
                <p className="text-ink-700 leading-relaxed">&ldquo;{q.quote}&rdquo;</p>
                <p className="mt-6 text-sm text-ink-400">{q.author}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-ink-400">
          Customer quotes are illustrative composites. Real testimonials will replace these as Maroa launches.
        </p>
      </section>

      {/* CTA BAND ─────────────────────────────────────────────────────────── */}
      <section className="container mt-32">
        <div className="rounded-3xl bg-ink-700 text-white px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display-lg text-white">
            Stop dreading Monday morning.
          </h2>
          <p className="mt-6 text-xl text-ink-100/80 max-w-2xl mx-auto leading-relaxed">
            Your week of content is just there. On-brand. On-channel. Ready to approve.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button href="/signup" variant="accent" size="xl">
              Start free
              <ArrowRight className="h-5 w-5" />
            </Button>
            <Link
              href="/pricing"
              className="text-white/80 hover:text-white underline-offset-4 hover:underline text-base"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
