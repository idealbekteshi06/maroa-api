import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Check, Users, Calendar, FileBarChart, ShieldCheck, Briefcase, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HeroPreview } from '@/components/marketing/hero-preview';

export const metadata: Metadata = {
  title: 'AI marketing software for agencies — multi-client workspaces & white-label',
  description:
    'Manage 50+ clients in one workspace. Role-based access, white-label reports, client approval flows, multi-client calendar. Scale without hiring.',
  alternates: { canonical: '/for-agencies' },
  openGraph: {
    title: 'Maroa for Agencies — multi-client workspaces & white-label',
    description: 'Scale without hiring. One workspace, every client, every channel.',
    url: '/for-agencies',
  },
};

const REASONS = [
  {
    icon: Layers,
    title: 'One workspace, every client',
    body: 'Switch between 50+ clients without re-logging-in. Each client gets its own brand voice, channels, compliance rules, and approval flow.',
  },
  {
    icon: Users,
    title: 'Roles your team actually uses',
    body: 'Owner · strategist · designer · client · viewer. Designers can\'t change spend. Clients see only their stuff. Audit log every action.',
  },
  {
    icon: Calendar,
    title: 'Multi-client calendar',
    body: 'See every campaign across every client in one calendar. Drag to reschedule. Pacing alerts collapse to one badge per client.',
  },
  {
    icon: FileBarChart,
    title: 'White-label reports',
    body: 'Branded PDF + magic-link web reports. Your logo, your colors, your domain. Clients see "[Your Agency] performance" — not "powered by Maroa."',
  },
  {
    icon: ShieldCheck,
    title: 'Compliance per industry',
    body: '20 industry rulesets (FDA, FTC, FCA, fair-housing, ABA). Each client\'s industry gates apply automatically — no manual setup.',
  },
  {
    icon: Briefcase,
    title: 'Client approval inbox',
    body: 'Magic-link approvals — clients approve from their phone, no Maroa account needed. SLA timers + reminder cadence built in.',
  },
];

const COMPARISON = [
  { row: 'Clients per workspace', maroa: 'Up to 50 (Agency) / unlimited (Enterprise)', alt: '5-10 typical' },
  { row: 'Cost per client', maroa: '$2-20/month', alt: '$50-200/month' },
  { row: 'Approval flow', maroa: 'Magic-link, no account', alt: 'PDF + email or "share my screen"' },
  { row: 'White-label', maroa: 'Logo + colors + custom domain', alt: 'Logo only or none' },
  { row: 'AI work', maroa: 'Daily decisions across content + ads + CRO + SEO + reviews', alt: 'One feature (content OR ads)' },
  { row: 'Reasoning trace', maroa: 'On every output — which framework + audience + claims', alt: 'None / black box' },
];

export default function ForAgenciesPage() {
  return (
    <>
      {/* HERO */}
      <section className="relative grain pt-12 sm:pt-20 lg:pt-28">
        <div className="container">
          <div className="mx-auto max-w-4xl text-center animate-fade-in-up">
            <p className="text-eyebrow uppercase text-ink-400 mb-6">For marketing agencies</p>
            <h1 className="text-display-xl text-ink-700 dark:text-ink-50">
              Scale your agency
              <br className="hidden sm:block" />
              <span className="text-ink-400">without scaling headcount.</span>
            </h1>
            <p className="mt-6 text-xl sm:text-2xl text-ink-400 max-w-3xl mx-auto leading-relaxed text-pretty">
              One workspace, every client, every channel. Maroa runs the strategy, creative, ads, CRO,
              SEO, and reporting for you. Your team supervises, approves, and grows.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button href="/signup?plan=agency" variant="primary" size="xl">
                Get started
                <ArrowRight className="h-5 w-5" />
              </Button>
              <Button href="/contact" variant="ghost" size="xl">
                Book a walkthrough
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
          <p className="text-eyebrow uppercase text-ink-400 mb-4">What you get</p>
          <h2 className="text-display-md text-ink-700 dark:text-ink-50">
            Built for the agency-of-one to agency-of-fifty.
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

      {/* COMPARISON */}
      <section className="container mt-32">
        <div className="max-w-3xl mx-auto text-center mb-12">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Honest comparison</p>
          <h2 className="text-display-md text-ink-700 dark:text-ink-50">
            How agencies compare today.
          </h2>
        </div>
        <div className="max-w-4xl mx-auto rounded-xl border border-ink-200/60 dark:border-ink-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 dark:bg-ink-900">
              <tr>
                <th className="text-left font-semibold text-ink-700 dark:text-ink-100 px-6 py-4"></th>
                <th className="text-left font-semibold text-ink-700 dark:text-ink-50 px-6 py-4">Maroa</th>
                <th className="text-left font-medium text-ink-400 px-6 py-4">Typical AI tool</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200/60 dark:divide-ink-800">
              {COMPARISON.map((c) => (
                <tr key={c.row} className="bg-white dark:bg-ink-900">
                  <td className="px-6 py-4 text-ink-700 dark:text-ink-100 font-medium">{c.row}</td>
                  <td className="px-6 py-4 text-ink-700 dark:text-ink-100">
                    <span className="inline-flex items-center gap-1.5">
                      <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
                      {c.maroa}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-ink-400">{c.alt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* CTA */}
      <section className="container mt-32">
        <div className="rounded-xl bg-ink-700 dark:bg-ink-800 text-white px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display-md text-white">Add your first three clients in ten minutes.</h2>
          <p className="mt-6 text-xl text-ink-100/80 max-w-2xl mx-auto leading-relaxed">
            See the difference between AI you babysit and a marketing OS that ships every day.
          </p>
          <Button href="/signup?plan=agency" variant="accent" size="xl" className="mt-10">
            Start with Agency
            <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      </section>
    </>
  );
}
