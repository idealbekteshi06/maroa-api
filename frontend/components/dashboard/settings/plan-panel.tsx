'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { startCheckout } from '@/lib/api/billing';

/**
 * components/dashboard/settings/plan-panel.tsx
 * ---------------------------------------------------------------------------
 * Two plan cards. Click "Upgrade" / "Switch" to open a Paddle checkout
 * session. The backend issues the checkout url; we redirect the window
 * to it. After payment, Paddle's webhook updates the plan on the
 * business row.
 * ---------------------------------------------------------------------------
 */

const TIERS = [
  {
    key: 'starter' as const,
    name: 'Starter',
    price: '$25',
    cadence: '/ month',
    audience: 'Solo SMB getting started',
    features: [
      '1 platform connected',
      '20 AI images per month',
      'AI brain once per day',
      'Content calendar',
      'Email support',
    ],
  },
  {
    key: 'growth' as const,
    name: 'Growth',
    price: '$59',
    cadence: '/ month',
    audience: 'Solo business · Freelancer with up to 5 clients',
    features: [
      'Up to 5 clients in your workspace',
      'All channels: Meta, Google, TikTok, LinkedIn, email',
      'Daily ad audits + pacing alerts every 4 hours',
      'Weekly performance scorecard',
      'Compliance gates for 20 regulated industries',
      'Reasoning trace on every output',
    ],
  },
  {
    key: 'agency' as const,
    name: 'Agency',
    price: '$99',
    cadence: '/ month',
    audience: 'Agency · 5–50 clients',
    highlighted: true,
    features: [
      'Up to 50 clients in one workspace',
      'Team roles (owner / strategist / designer / viewer)',
      'White-label PDF + magic-link client reports',
      'Custom domain — clients see your brand',
      'Magic-link client approval inbox',
      'A/B testing on every campaign',
      'Higgsfield image + video on every draft',
      'Audit log export · API access · Priority support',
    ],
  },
];

export function PlanPanel({ currentPlan }: { currentPlan: string }) {
  return (
    <div className="space-y-4">
      <CurrentBanner plan={currentPlan} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {TIERS.map((t) => (
          <TierCard
            key={t.key}
            tier={t}
            isCurrent={currentPlan === t.key || (currentPlan === 'solo' && t.key === 'growth')}
          />
        ))}
      </div>
      <p className="text-xs text-ink-500 dark:text-ink-300 text-center">
        Need more than 50 clients? Talk to us at{' '}
        <a
          href="mailto:hello@maroa.ai"
          className="text-accent-500 hover:text-accent-600 font-medium"
        >
          hello@maroa.ai
        </a>
        .
      </p>
    </div>
  );
}

function CurrentBanner({ plan }: { plan: string }) {
  const label =
    plan === 'agency'
      ? 'Agency · $99/mo'
      : plan === 'growth' || plan === 'solo'
        ? 'Growth · $59/mo'
        : plan === 'starter' || plan === 'free'
          ? 'Starter · $25/mo'
          : plan;
  return (
    <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/60 dark:bg-ink-900/40 px-5 py-4 flex items-center justify-between">
      <div>
        <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">Current plan</p>
        <p className="mt-1 text-lg text-ink-700 dark:text-ink-50 font-semibold">{label}</p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 px-2.5 py-1 text-xs font-medium">
        <Check className="h-3 w-3" aria-hidden="true" />
        Active
      </span>
    </div>
  );
}

interface Tier {
  key: 'growth' | 'agency';
  name: string;
  price: string;
  cadence: string;
  audience: string;
  features: string[];
  highlighted?: boolean;
}

function TierCard({ tier, isCurrent }: { tier: Tier; isCurrent: boolean }) {
  const [pending, startTransition] = useTransition();

  function goToCheckout() {
    startTransition(async () => {
      try {
        // The backend resolves the user id from the JWT — passing null is
        // fine; the route reads req.user.id when token is present. We send
        // the empty string to satisfy the type and let the backend fill in.
        const successUrl =
          typeof window !== 'undefined'
            ? `${window.location.origin}/settings/plan?status=success`
            : undefined;
        const session = await startCheckout('', tier.key, successUrl);
        if (!session?.url) throw new Error('Backend did not return a checkout URL.');
        window.location.href = session.url;
      } catch (e) {
        toast.error("Couldn't open checkout", {
          description: errorMessage(e, 'Try again or email hello@maroa.ai.'),
        });
      }
    });
  }

  return (
    <article
      className={cn(
        'rounded-xl border bg-white dark:bg-ink-900 shadow-subtle p-6 sm:p-7 flex flex-col',
        tier.highlighted
          ? 'border-accent-200/60 dark:border-accent-900/40 ring-1 ring-accent-200/60 dark:ring-accent-900/40'
          : 'border-ink-200/60 dark:border-ink-800',
      )}
    >
      <header>
        <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">{tier.audience}</p>
        <h3 className="mt-2 text-xl text-ink-700 dark:text-ink-50 font-semibold">{tier.name}</h3>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span className="text-4xl text-ink-700 dark:text-ink-50 font-semibold tracking-tight">
            {tier.price}
          </span>
          <span className="text-sm text-ink-500 dark:text-ink-300">{tier.cadence}</span>
        </p>
      </header>
      <ul className="mt-5 space-y-2.5 text-sm text-ink-700 dark:text-ink-100 flex-1">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <Check
              className="h-4 w-4 mt-0.5 text-accent-500 shrink-0"
              aria-hidden="true"
            />
            <span className="leading-relaxed">{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        {isCurrent ? (
          <span className="inline-flex items-center justify-center w-full rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 px-6 py-2.5 text-sm font-medium">
            Your current plan
          </span>
        ) : (
          <button
            type="button"
            onClick={goToCheckout}
            disabled={pending}
            className={cn(
              'inline-flex items-center justify-center w-full rounded-full px-6 py-2.5 text-sm font-semibold transition-shadow gap-2',
              tier.highlighted
                ? 'bg-accent-500 text-white hover:shadow-card'
                : 'bg-ink-700 dark:bg-white text-white dark:text-ink-900 hover:shadow-card',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:opacity-60',
            )}
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Opening checkout…
              </>
            ) : (
              <>
                Switch to {tier.name}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}
