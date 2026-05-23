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

export const metadata: Metadata = {
  title: 'Pricing — $25 Starter · $59 Growth · $99 Agency',
  description:
    'Starter at $25/mo, Growth at $59/mo for growing SMBs, Agency at $99/mo for teams managing multiple clients. Monthly billing in USD. Cancel anytime.',
  alternates: { canonical: '/pricing' },
};

const PLANS = [
  {
    name: 'Starter',
    audience: 'Solo SMB · First connected channel',
    tagline: 'Essential AI marketing for one business.',
    price: '$25',
    cadence: '/ month',
    cta: { label: 'Get started', href: '/signup?plan=starter' },
    highlight: false,
    features: [
      '1 platform',
      '20 AI images per month',
      'AI brain once per day',
      'Content calendar',
      'Email support',
    ],
  },
  {
    name: 'Growth',
    audience: 'Growing SMB · Up to 3 platforms',
    tagline: 'Daily content, ads, and competitor intel.',
    price: '$59',
    cadence: '/ month',
    cta: { label: 'Get started', href: '/signup?plan=growth' },
    highlight: true,
    features: [
      '3 platforms — Meta, Google, social, email',
      '60 AI images per month',
      'Paid ads + daily audits',
      'Competitor tracking',
      'Weekly performance scorecard',
      'Brand voice per business',
    ],
  },
  {
    name: 'Agency',
    audience: 'Agency · Multi-client workspace',
    tagline: 'White-label reports and team workflows.',
    price: '$99',
    cadence: '/ month',
    cta: { label: 'Get started', href: '/signup?plan=agency' },
    highlight: false,
    features: [
      '3 brands in workspace',
      '120 AI images per month',
      'White-label client reports',
      'Team roles + approval inbox',
      'API access',
      'Priority support',
    ],
  },
];

const FAQ = [
  {
    q: 'Is there a free trial or money-back guarantee?',
    a: "No. We don't do trials or refunds — every account is monthly and you can cancel any time before your next renewal.",
  },
  {
    q: 'Can I switch plans?',
    a: 'Yes, in either direction, any time. Upgrades pro-rate to the day. Downgrades take effect at the next billing cycle.',
  },
  {
    q: 'Do I keep the content if I cancel?',
    a: 'Yes. Export your library from Settings → Data before or after cancellation.',
  },
  {
    q: 'What if I need more than 3 agency brands?',
    a: 'Talk to us about Enterprise — custom limits, data residency, and dedicated support.',
  },
];

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
            Three plans.
            <br />
            <span className="text-ink-400">Priced for SMB marketing teams.</span>
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-xl mx-auto leading-relaxed">
            Monthly billing in USD. Cancel anytime from Settings → Billing.
          </p>
        </div>
      </section>

      <section className="container mt-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
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

        <div className="mt-8 max-w-6xl mx-auto rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-8 flex flex-col md:flex-row items-start md:items-center gap-6 md:gap-10">
          <div className="h-12 w-12 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center flex-shrink-0">
            <Users className="h-6 w-6 text-ink-700 dark:text-ink-100" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-eyebrow uppercase text-accent-500 dark:text-accent-400 mb-1">
              Enterprise
            </p>
            <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50">
              Custom limits, dedicated SLA, annual contracts.
            </h3>
          </div>
          <Button href="/contact" variant="primary" size="lg" className="flex-shrink-0">
            Talk to sales
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
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
