import type { Metadata } from 'next';
import { Check, ArrowRight, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'Pricing — simple, predictable, no surprises',
  description:
    'Free for 7 days, no credit card. Plans for solo SMBs, freelancers managing 20 clients, agencies managing 50+, and enterprise. Cancel anytime.',
  alternates: { canonical: '/pricing' },
};

const PLANS = [
  {
    name: 'Free',
    audience: 'Try it',
    tagline: '7-day trial, no card.',
    price: '$0',
    cadence: '/ trial',
    cta: { label: 'Start free', href: '/signup' },
    highlight: false,
    features: [
      'Up to 5 posts / week',
      '1 social account',
      'Industry-aware drafts',
      'Compliance gates (FDA / FTC)',
      'Brand voice anchor',
    ],
  },
  {
    name: 'Growth',
    audience: 'Solo SMB',
    tagline: 'One business, fully automated.',
    price: '$49',
    cadence: '/ month',
    cta: { label: 'Start free trial', href: '/signup?plan=growth' },
    highlight: false,
    features: [
      'Up to 30 posts / week',
      'All social accounts',
      'Meta + Google ad audits',
      'Pacing alerts (every 4h)',
      'Weekly performance scorecard',
      'Cold-start corpus grounding',
      '2 expert examples per draft',
    ],
  },
  {
    name: 'Freelancer',
    audience: '5–20 clients',
    tagline: 'A marketing team for every client.',
    price: '$199',
    cadence: '/ month',
    cta: { label: 'Start free trial', href: '/signup?plan=freelancer' },
    highlight: true,
    features: [
      'Up to 20 clients',
      'Workspace + War Room dashboard',
      'Client approval magic-links',
      'White-label PDF reports',
      'Reasoning trace on every output',
      'A/B testing on every campaign',
      'Higgsfield image + video',
      '5 expert examples per draft',
    ],
  },
  {
    name: 'Agency',
    audience: '20–50 clients',
    tagline: 'Multi-team, full white-label.',
    price: '$499',
    cadence: '/ month',
    cta: { label: 'Start free trial', href: '/signup?plan=agency' },
    highlight: false,
    features: [
      'Up to 50 clients',
      'Team roles (owner / strategist / designer / viewer)',
      'Custom domain white-label',
      'Brand voice training per client',
      'Priority support',
      'Audit log export',
      'API access',
    ],
  },
];

const FAQ = [
  {
    q: 'Do I need a credit card to start?',
    a: 'No. The 7-day trial is free and requires no card. We ask for payment only when you decide to continue.',
  },
  {
    q: 'What happens after the trial?',
    a: 'Your account converts to Free (read-only on past content) unless you pick a paid plan. Your data stays. Nothing is published without your approval.',
  },
  {
    q: 'Can I switch plans?',
    a: 'Anytime, both directions. Up-grades pro-rate; down-grades take effect next billing cycle.',
  },
  {
    q: 'How do client seats work on Freelancer + Agency?',
    a: 'Each client is one seat. A seat includes their content, ads, reports, social accounts, and approvals — billed to your workspace, never the client. You can pause or offboard a client to free the seat.',
  },
  {
    q: 'Do I keep the content if I cancel?',
    a: 'Yes. Everything Maroa produces is yours. You can export at any time as a .zip.',
  },
  {
    q: 'How do you handle my (and my clients\') data?',
    a: 'We never sell or share. OAuth tokens are encrypted at rest (AES-256-GCM). All data is processed in the EU or US (your choice). See our DPA for details.',
  },
];

export default function PricingPage() {
  return (
    <>
      <section className="container pt-20 sm:pt-28">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Pricing</p>
          <h1 className="text-display-lg text-ink-700 dark:text-ink-50">
            One operating system.
            <br />
            <span className="text-ink-400">Priced to fit your stage.</span>
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-xl mx-auto leading-relaxed">
            From your first business to your fiftieth client. Cancel anytime. The first 7 days are
            on us.
          </p>
        </div>
      </section>

      <section className="container mt-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-3xl p-8 transition-all duration-300 flex flex-col',
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

        <div className="mt-8 max-w-7xl mx-auto rounded-3xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-8 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-10">
          <div className="h-12 w-12 rounded-2xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center flex-shrink-0">
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
          Prices in USD. Annual billing saves ~16%. Volume discounts above 50 clients.
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
