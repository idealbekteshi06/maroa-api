import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Sparkles,
  Target,
  Search,
  Mail,
  BarChart3,
  MessageCircle,
  ShieldCheck,
  FileCheck,
  Link2,
  Cpu,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HeroPreview } from '@/components/marketing/hero-preview';

export const metadata: Metadata = {
  title: 'Maroa — AI Marketing for Every Business',
  description:
    'Maroa creates your posts, writes your ads, tracks your competitors, and grows your business — automatically. In 22 countries and 17 languages.',
  alternates: { canonical: '/' },
};

// ─── Content ────────────────────────────────────────────────────────────────
// All copy below mirrors the live maroa.ai homepage voice + structure, updated
// to reflect the product as built. No pre-launch framing, no stale dates, no
// composite testimonials. The 6 feature cards lead with the live-site set
// plus Maroa's two real differentiators (compliance + reasoning trace).

const COUNTRIES = ['🇽🇰', '🇦🇱', '🇬🇧', '🇩🇪', '🇦🇪', '🇺🇸', '🇫🇷', '🇮🇹'];

const FEATURES: Array<{
  icon: typeof Sparkles;
  title: string;
  body: string;
}> = [
  {
    icon: Sparkles,
    title: 'AI Content Creation',
    body:
      'Posts, captions, ads, and emails — written by AI that knows your business, your city, and your customers.',
  },
  {
    icon: Target,
    title: 'Ad Optimization',
    body:
      'Meta and Google ads managed by AI. Budgets shift automatically to what converts, every single day.',
  },
  {
    icon: Search,
    title: 'Competitor Tracking',
    body:
      "Know what your competitors are posting, what's working for them, and how to outperform them.",
  },
  {
    icon: ShieldCheck,
    title: 'Compliance Built In',
    body:
      'Auto-blocks claims that violate FDA, FTC, FCA, or platform policy. Healthcare, finance, alcohol — protected by design.',
  },
  {
    icon: FileCheck,
    title: 'Reasoning You Can Read',
    body:
      'Every decision ships with a trace — which framework, which audience stage, which constraints checked. No black box.',
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    body:
      'Understands what content performs best and automatically does more of what works across every channel.',
  },
  {
    icon: Mail,
    title: 'Email Automation',
    body:
      'Welcome sequences, cart recovery, re-engagement — all running on autopilot with personalised content.',
  },
  {
    icon: MessageCircle,
    title: 'Unified Inbox',
    body:
      'Instagram, Facebook, WhatsApp, and email — every customer conversation in one AI-powered queue.',
  },
];

const HOW_STEPS: Array<{
  step: string;
  icon: typeof Link2;
  title: string;
  body: string;
}> = [
  {
    step: '01',
    icon: Link2,
    title: 'Connect your accounts',
    body:
      'Link Instagram, Facebook, Google, and email in under 2 minutes. We handle the OAuth, you just click.',
  },
  {
    step: '02',
    icon: Cpu,
    title: 'AI analyses your brand',
    body:
      'Maroa reads your brand, studies your competitors, and builds a strategy unique to your business and market.',
  },
  {
    step: '03',
    icon: Zap,
    title: 'Everything runs automatically',
    body:
      'Content, ads, emails, and insights — running 24/7. You approve what matters, AI handles the rest.',
  },
];

const STATS: Array<{ number: string; label: string }> = [
  { number: '22', label: 'Countries supported' },
  { number: '17', label: 'Languages' },
  { number: '99%', label: 'Uptime' },
  { number: '10min', label: 'Setup time' },
];

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <>
      {/* HERO ─────────────────────────────────────────────────────────────── */}
      <section className="relative pt-16 sm:pt-24 lg:pt-32 pb-12 sm:pb-16">
        <div className="container">
          <div className="mx-auto max-w-5xl text-center">
            <div className="mb-8 flex justify-center">
              <div className="pill">
                <span className="pill-dot agent-pulse" aria-hidden="true" />
                <span>Live · 22 countries · 17 languages</span>
              </div>
            </div>

            {/* 3-line display headline. DM Sans 700 at hero size carries the
                live-site feel; the middle line fills with the brand cobalt. */}
            <h1 className="font-bold tracking-[-0.03em] text-ink-700 dark:text-ink-50 leading-[1.02] text-[clamp(2.75rem,7.2vw,6rem)]">
              <span className="block">Your Marketing.</span>
              <span className="block text-accent-500">Automated by AI.</span>
              <span className="block">While You Sleep.</span>
            </h1>

            <p className="mt-7 text-lg sm:text-xl text-ink-500 dark:text-ink-300 max-w-2xl mx-auto leading-relaxed text-pretty">
              Maroa creates your posts, writes your ads, tracks your competitors, and grows
              your business — automatically. In 22 countries and 17 languages.
            </p>

            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button href="/signup" variant="primary" size="xl">
                Start free trial
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button href="/pricing" variant="ghost" size="xl">
                View plans &amp; pricing
              </Button>
            </div>

            <p className="mt-6 text-sm text-ink-400 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              <span>7-day free trial</span>
              <span aria-hidden="true" className="text-ink-300 dark:text-ink-600">·</span>
              <span>No credit card</span>
              <span aria-hidden="true" className="text-ink-300 dark:text-ink-600">·</span>
              <span>Cancel anytime</span>
            </p>

            <div
              className="mt-10 flex items-center justify-center gap-2 text-2xl select-none"
              aria-label="Countries available"
            >
              {COUNTRIES.map((flag, i) => (
                <span key={i} aria-hidden="true">{flag}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* WHAT MAROA DOES — feature grid ───────────────────────────────────── */}
      <section className="container mt-24 sm:mt-32">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-eyebrow uppercase text-accent-500 mb-4 font-semibold tracking-[0.18em]">
            What Maroa does
          </p>
          <h2 className="font-bold tracking-tight text-ink-700 dark:text-ink-50 text-[clamp(2rem,4.5vw,3.5rem)] leading-[1.08]">
            Set it up once. Let AI handle everything.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-6xl mx-auto">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className="rounded-2xl bg-ink-50 dark:bg-ink-900 border border-ink-100 dark:border-ink-800 p-6 hover:border-accent-200 dark:hover:border-accent-700/40 transition-colors"
            >
              <div className="h-11 w-11 rounded-xl bg-accent-50 dark:bg-accent-500/10 flex items-center justify-center mb-5">
                <f.icon className="h-5 w-5 text-accent-500" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-ink-700 dark:text-ink-100 mb-2">
                {f.title}
              </h3>
              <p className="text-sm text-ink-500 dark:text-ink-400 leading-relaxed">
                {f.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* SEE IT IN MOTION — product preview ───────────────────────────────── */}
      <section className="container mt-24 sm:mt-32">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <p className="text-eyebrow uppercase text-accent-500 mb-4 font-semibold tracking-[0.18em]">
            See it in motion
          </p>
          <h2 className="font-bold tracking-tight text-ink-700 dark:text-ink-50 text-[clamp(1.875rem,4vw,3rem)] leading-[1.1]">
            A live look at the War Room.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-ink-500 dark:text-ink-300 max-w-2xl mx-auto leading-relaxed">
            What Maroa surfaces, refuses, and ships — accumulating in real time.
          </p>
        </div>
        <div className="relative">
          <span className="preview-floor" aria-hidden="true" />
          <HeroPreview />
        </div>
      </section>

      {/* HOW IT WORKS — 3 steps ───────────────────────────────────────────── */}
      <section className="container mt-24 sm:mt-32">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-eyebrow uppercase text-accent-500 mb-4 font-semibold tracking-[0.18em]">
            How it works
          </p>
          <h2 className="font-bold tracking-tight text-ink-700 dark:text-ink-50 text-[clamp(2rem,4.5vw,3.5rem)] leading-[1.08]">
            Three steps. Ten minutes. Done.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-6xl mx-auto">
          {HOW_STEPS.map((s) => (
            <article
              key={s.step}
              className="rounded-2xl bg-ink-50 dark:bg-ink-900 border border-ink-100 dark:border-ink-800 p-6"
            >
              <div className="flex items-center gap-3 mb-5">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-accent-500 text-white text-xs font-semibold tabular-nums">
                  {s.step}
                </span>
                <s.icon className="h-4 w-4 text-accent-500" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-semibold text-ink-700 dark:text-ink-100 mb-2">
                {s.title}
              </h3>
              <p className="text-sm text-ink-500 dark:text-ink-400 leading-relaxed">
                {s.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* STATS — single muted panel, 4 numbers ────────────────────────────── */}
      <section className="container mt-16 sm:mt-20">
        <div className="rounded-2xl bg-ink-50 dark:bg-ink-900 border border-ink-100 dark:border-ink-800 px-6 py-10 sm:px-12 sm:py-12 max-w-6xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {STATS.map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-3xl sm:text-5xl font-bold text-accent-500 tracking-tight tabular-nums">
                  {s.number}
                </p>
                <p className="mt-2 text-[11px] uppercase tracking-[0.16em] text-ink-400 font-medium">
                  {s.label}
                </p>
              </div>
            ))}
          </div>
          <p
            className="mt-8 text-center text-2xl select-none"
            aria-hidden="true"
          >
            {COUNTRIES.map((flag, i) => (
              <span key={i} className="mx-1">{flag}</span>
            ))}
          </p>
          <p className="mt-3 text-center text-sm text-ink-400">
            From Kosovo to Dubai to London — choosing AI over agencies.
          </p>
        </div>
      </section>

      {/* PRICING TEASER ───────────────────────────────────────────────────── */}
      <section className="container mt-24 sm:mt-32">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-eyebrow uppercase text-accent-500 mb-4 font-semibold tracking-[0.18em]">
            Pricing
          </p>
          <h2 className="font-bold tracking-tight text-ink-700 dark:text-ink-50 text-[clamp(2rem,4.5vw,3.5rem)] leading-[1.08]">
            Start free, upgrade as you grow.
          </h2>
          <p className="mt-5 text-base sm:text-lg text-ink-500 dark:text-ink-300 leading-relaxed max-w-xl mx-auto">
            No credit card required. Try every feature free for 7 days, then pick the plan
            that fits your business.
          </p>
          <div className="mt-8">
            <Button href="/pricing" variant="primary" size="xl">
              View plans &amp; pricing
              <ArrowRight className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </section>

      {/* FINAL CTA ───────────────────────────────────────────────────────── */}
      <section className="container mt-24 sm:mt-32 mb-24">
        <div className="max-w-4xl mx-auto rounded-3xl border border-accent-200/60 dark:border-accent-500/20 bg-gradient-to-b from-accent-50 via-white to-white dark:from-accent-500/10 dark:via-ink-900 dark:to-ink-900 px-6 py-16 sm:px-16 sm:py-20 text-center">
          <h2 className="font-bold tracking-tight text-ink-700 dark:text-ink-50 text-[clamp(1.875rem,4vw,3rem)] leading-[1.1]">
            Ready to put your marketing on autopilot?
          </h2>
          <p className="mt-5 text-base sm:text-lg text-ink-500 dark:text-ink-300 max-w-2xl mx-auto leading-relaxed">
            Setup takes 10 minutes. Results start on day one.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button href="/signup" variant="primary" size="xl">
              Start free trial
              <ArrowRight className="h-5 w-5" />
            </Button>
            <Button href="/contact" variant="ghost" size="xl">
              Book a demo
            </Button>
          </div>
          <p className="mt-6 text-sm text-ink-400">
            No credit card · 7-day free trial · Cancel anytime
          </p>
        </div>
      </section>
    </>
  );
}
