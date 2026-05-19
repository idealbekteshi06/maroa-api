import type { Metadata } from 'next';
import { Check, ArrowRight, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  softwareApplicationSchema,
  faqPageSchema,
  breadcrumbSchema,
  ldJson,
  SITE_URL,
} from '@/lib/schema-org';

// Audit 2026-05-19 F20: title was "Pricing — Maroa" (14 chars). Now sized
// for SERP intent — 56 chars including the $ figures.
export const metadata: Metadata = {
  title: 'Pricing — $149/mo Growth · $599/mo Agency · cancel anytime',
  description:
    'Two plans. Growth at $149/mo for solo SMBs and small teams. Agency at $599/mo for freelancers and agencies running up to 50 clients. Monthly billing in USD. Cancel anytime.',
  alternates: { canonical: '/pricing' },
};

const PLANS = [
  {
    name: 'Growth',
    audience: 'Solo SMB · Freelancer with 1–5 clients',
    tagline: 'One operating system for the marketing you keep meaning to do.',
    price: '$149',
    cadence: '/ month',
    cta: { label: 'Get started', href: '/signup?plan=growth' },
    highlight: false,
    features: [
      'Up to 5 businesses or clients',
      'All channels — Meta, Google, TikTok, LinkedIn, Pinterest, YouTube, email',
      'Daily ad audits + pacing alerts (every 4 hours)',
      'Weekly performance scorecard',
      'Brand voice + visual DNA per client',
      'Compliance gates for 20 regulated industries',
      'Cold-start corpus grounding (2 examples per draft)',
      'Reasoning trace on every output',
    ],
  },
  {
    name: 'Agency',
    audience: 'Freelancer · Agency · 5–50 clients',
    tagline: 'Scale without hiring. Every client gets a team of agents.',
    price: '$599',
    cadence: '/ month',
    cta: { label: 'Get started', href: '/signup?plan=agency' },
    highlight: true,
    features: [
      'Up to 50 clients in one workspace',
      'Team roles (owner / strategist / designer / viewer)',
      'White-label PDF + magic-link client reports',
      'Custom domain — clients see your brand',
      'Magic-link client approval inbox',
      'Multi-client calendar + content pipeline',
      'Higgsfield image + video on every draft',
      'Cold-start corpus grounding (5 examples per draft)',
      'A/B testing on every campaign',
      'Audit log export · API access · Priority support',
    ],
  },
];

const FAQ = [
  {
    q: 'Is there a free trial or money-back guarantee?',
    a: 'No. We don\'t do trials or refunds — every account is monthly and you can cancel any time before your next renewal. Cancellation stops the next charge; access continues to the end of the current period. The /features page and the public dashboard demo show exactly what you\'re getting before you commit.',
  },
  {
    q: 'How is "client" defined?',
    a: 'One client = one business with its own brand voice, social accounts, ad accounts, and approval inbox. You can pause or off-board a client at any time to free the seat. There are no per-client overage fees inside your plan tier.',
  },
  {
    q: 'Can I switch between Growth and Agency?',
    a: 'Yes, in either direction, any time. Up-grades pro-rate to the day. Down-grades take effect at the next billing cycle. Your data, content history, and brand voices are preserved across switches.',
  },
  {
    q: 'Do I keep the content if I cancel?',
    a: 'Yes. Everything Maroa produces is yours. You can export your full content library, audit log, and reasoning traces as a .zip from Settings → Data at any point — before or after cancellation.',
  },
  {
    q: 'What if I have more than 50 clients?',
    a: 'Talk to us about Enterprise. Single-tenant deployment, custom data residency (EU / US / sovereign), SOC 2 audit support, dedicated CSM, custom integrations. Annual contracts.',
  },
  {
    q: 'How do you handle data?',
    a: 'We never sell or share. OAuth tokens are encrypted at rest (AES-256-GCM). All data is processed in the EU or US (your choice). See our DPA for the full controls list.',
  },
];

// Audit 2026-05-19 F18 + F19: ship structured data so Google can render
// the price rich snippet and AI search can extract individual FAQ Q&As.
const PRICING_SCHEMAS = [
  softwareApplicationSchema({ url: `${SITE_URL}/pricing` }),
  faqPageSchema(FAQ.map((f) => ({ question: f.q, answer: f.a }))),
  breadcrumbSchema([
    { name: 'Home', url: SITE_URL },
    { name: 'Pricing', url: `${SITE_URL}/pricing` },
  ]),
];

export default function PricingPage() {
  return (
    <>
      {PRICING_SCHEMAS.map((schema, i) => (
        <script
          key={i}
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: ldJson(schema) }}
        />
      ))}
      <section className="container pt-20 sm:pt-28">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Pricing</p>
          <h1 className="text-display-lg text-ink-700 dark:text-ink-50">
            Two plans.
            <br />
            <span className="text-ink-400">Priced to replace a marketing hire.</span>
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-xl mx-auto leading-relaxed">
            Monthly billing in USD. Cancel anytime from Settings → Billing — no negotiation,
            no retention call.
          </p>
        </div>
      </section>

      <section className="container mt-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-xl p-8 transition-all duration-300 flex flex-col',
                plan.highlight
                  ? 'bg-ink-700 dark:bg-ink-800 text-white shadow-lifted scale-[1.02]'
                  : 'bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 shadow-subtle hover:shadow-card dark:hover:border-ink-700',
              )}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-accent-500 text-white text-xs font-semibold uppercase tracking-wider rounded-full">
                  Most popular
                </div>
              )}

              <p
                className={cn(
                  'text-xs uppercase tracking-wider font-medium mb-2',
                  plan.highlight ? 'text-accent-200' : 'text-accent-500 dark:text-accent-400',
                )}
              >
                {plan.audience}
              </p>
              <h3
                className={cn(
                  'text-xl font-semibold',
                  plan.highlight ? 'text-white' : 'text-ink-700 dark:text-ink-50',
                )}
              >
                {plan.name}
              </h3>
              <p
                className={cn(
                  'mt-1 text-sm leading-snug',
                  plan.highlight ? 'text-ink-100/70' : 'text-ink-400',
                )}
              >
                {plan.tagline}
              </p>

              <div className="mt-8 flex items-baseline gap-1">
                <span
                  className={cn(
                    'text-5xl font-semibold tracking-tight',
                    plan.highlight ? 'text-white' : 'text-ink-700 dark:text-ink-50',
                  )}
                >
                  {plan.price}
                </span>
                <span
                  className={cn(
                    'text-sm',
                    plan.highlight ? 'text-ink-100/70' : 'text-ink-400',
                  )}
                >
                  {plan.cadence}
                </span>
              </div>

              <Button
                href={plan.cta.href}
                variant={plan.highlight ? 'accent' : 'primary'}
                size="lg"
                className="mt-8 w-full"
              >
                {plan.cta.label}
                <ArrowRight className="h-4 w-4" />
              </Button>

              <ul className="mt-10 space-y-3 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check
                      className={cn(
                        'h-5 w-5 flex-shrink-0 mt-0.5',
                        plan.highlight ? 'text-accent-200' : 'text-accent-500 dark:text-accent-400',
                      )}
                    />
                    <span
                      className={cn(
                        'text-sm leading-snug',
                        plan.highlight ? 'text-ink-100/90' : 'text-ink-700 dark:text-ink-200',
                      )}
                    >
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-8 max-w-4xl mx-auto rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-8 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-10">
          <div className="h-12 w-12 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center flex-shrink-0">
            <Users className="h-6 w-6 text-ink-700 dark:text-ink-100" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-eyebrow uppercase text-accent-500 dark:text-accent-400 mb-1">
              Enterprise
            </p>
            <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50">
              50+ clients, dedicated SLA, custom retention.
            </h3>
            <p className="mt-1 text-sm text-ink-400 leading-snug max-w-2xl">
              Single-tenant deployment, custom data residency (EU / US / sovereign), SOC 2 audit
              support, custom integrations, dedicated CSM. Annual contract.
            </p>
          </div>
          <Button href="/contact" variant="primary" size="lg" className="flex-shrink-0">
            Talk to sales
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <p className="mt-10 text-center text-sm text-ink-400">
          Prices in USD. Monthly billing only. Cancel any time.
        </p>
      </section>

      <section className="container mt-32">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-display-md text-ink-700 dark:text-ink-50 text-center mb-12">
            Questions, answered.
          </h2>
          <dl className="space-y-8">
            {FAQ.map((item) => (
              <div
                key={item.q}
                className="border-b border-ink-200/60 dark:border-ink-800 pb-8"
              >
                <dt className="text-lg font-semibold text-ink-700 dark:text-ink-100">{item.q}</dt>
                <dd className="mt-3 text-ink-400 leading-relaxed">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}
