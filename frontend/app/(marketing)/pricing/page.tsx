import type { Metadata } from 'next';
import { Check, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'Pricing — simple, predictable, no surprises',
  description:
    'Three plans, monthly or yearly. Free for 7 days, no credit card needed. Cancel anytime.',
  alternates: { canonical: '/pricing' },
};

const PLANS = [
  {
    name: 'Free',
    tagline: 'Try it for 7 days',
    price: '$0',
    cadence: '/ trial',
    cta: { label: 'Start free', href: '/signup' },
    highlight: false,
    features: [
      'Up to 5 posts / week',
      '1 social account',
      'Industry-aware drafts',
      'Compliance gates',
      'Brand voice anchor',
    ],
  },
  {
    name: 'Growth',
    tagline: 'For shops with budget to scale',
    price: '$49',
    cadence: '/ month',
    cta: { label: 'Start free trial', href: '/signup?plan=growth' },
    highlight: true,
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
    name: 'Agency',
    tagline: 'For multi-location or higher-spend',
    price: '$99',
    cadence: '/ month',
    cta: { label: 'Start free trial', href: '/signup?plan=agency' },
    highlight: false,
    features: [
      'Unlimited posts',
      'Up to 10 businesses',
      'Reasoning trace on every output',
      'A/B testing on every campaign',
      '5 expert examples per draft',
      'Priority support',
      'Custom brand voice training',
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
    q: 'Do I keep the content if I cancel?',
    a: 'Yes. Everything Maroa produces is yours. You can export at any time.',
  },
  {
    q: 'How do you handle my customer data?',
    a: 'We never sell or share. OAuth tokens are encrypted at rest (AES-256-GCM). All data is processed in the EU or US (your choice). See our DPA for details.',
  },
];

export default function PricingPage() {
  return (
    <>
      <section className="container pt-20 sm:pt-28">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Pricing</p>
          <h1 className="text-display-lg text-ink-700">
            Simple, predictable.
            <br />
            <span className="text-ink-400">No surprises.</span>
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-xl mx-auto leading-relaxed">
            Three plans. Cancel anytime. The first 7 days are on us.
          </p>
        </div>
      </section>

      <section className="container mt-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'relative rounded-3xl p-8 transition-all duration-300',
                plan.highlight
                  ? 'bg-ink-700 text-white shadow-lifted scale-[1.02]'
                  : 'bg-white border border-ink-200/60 shadow-subtle hover:shadow-card',
              )}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-accent-500 text-white text-xs font-semibold uppercase tracking-wider rounded-full">
                  Most popular
                </div>
              )}

              <h3 className={cn('text-xl font-semibold', plan.highlight ? 'text-white' : 'text-ink-700')}>
                {plan.name}
              </h3>
              <p className={cn('mt-1 text-sm', plan.highlight ? 'text-ink-100/70' : 'text-ink-400')}>
                {plan.tagline}
              </p>

              <div className="mt-8 flex items-baseline gap-1">
                <span className={cn('text-5xl font-semibold tracking-tight', plan.highlight ? 'text-white' : 'text-ink-700')}>
                  {plan.price}
                </span>
                <span className={cn('text-sm', plan.highlight ? 'text-ink-100/70' : 'text-ink-400')}>
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

              <ul className="mt-10 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check
                      className={cn(
                        'h-5 w-5 flex-shrink-0 mt-0.5',
                        plan.highlight ? 'text-accent-200' : 'text-accent-500',
                      )}
                    />
                    <span className={cn('text-sm leading-snug', plan.highlight ? 'text-ink-100/90' : 'text-ink-700')}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-10 text-center text-sm text-ink-400">
          Prices in USD. Annual billing saves ~16%. Volume discounts available for agency tier above 10 businesses.
        </p>
      </section>

      <section className="container mt-32">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-display-md text-ink-700 text-center mb-12">Questions, answered.</h2>
          <dl className="space-y-8">
            {FAQ.map((item) => (
              <div key={item.q} className="border-b border-ink-200/60 pb-8">
                <dt className="text-lg font-semibold text-ink-700">{item.q}</dt>
                <dd className="mt-3 text-ink-400 leading-relaxed">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}
