'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { onboarding } from '@/lib/api';
import { cn } from '@/lib/cn';

type StepId = 'business' | 'audience' | 'connect' | 'voice' | 'confirm';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'business', label: 'Business' },
  { id: 'audience', label: 'Audience' },
  { id: 'connect', label: 'Connect' },
  { id: 'voice', label: 'Voice' },
  { id: 'confirm', label: 'Launch' },
];

const INDUSTRIES = [
  'Dental clinic',
  'Café / coffee shop',
  'Restaurant',
  'Plumber / trades',
  'Gym / fitness studio',
  'Hair / beauty salon',
  'Local retail',
  'SaaS / software',
  'Real estate',
  'Other',
];

export default function OnboardingPage() {
  const router = useRouter();
  const [current, setCurrent] = useState<StepId>('business');
  const [data, setData] = useState({
    businessName: '',
    industry: '',
    region: '',
    audience: '',
    goal: '',
    voiceSeed: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idx = STEPS.findIndex((s) => s.id === current);

  const next = () => setCurrent(STEPS[Math.min(STEPS.length - 1, idx + 1)].id);
  const prev = () => setCurrent(STEPS[Math.max(0, idx - 1)].id);

  const finish = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onboarding.start({
        businessName: data.businessName,
        industry: data.industry,
        region: data.region,
        goal: data.goal || undefined,
      });
      router.push('/dashboard');
    } catch (e: any) {
      setError(e?.message || 'Onboarding failed. Try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      {/* Progress */}
      <div className="flex items-center justify-between mb-12" aria-label="Onboarding progress">
        {STEPS.map((s, i) => {
          const done = i < idx;
          const active = i === idx;
          return (
            <div key={s.id} className="flex-1 flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'h-9 w-9 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                    done && 'bg-ink-700 text-white',
                    active && 'bg-accent-500 text-white',
                    !done && !active && 'bg-ink-100 text-ink-400',
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : i + 1}
                </div>
                <span className={cn('mt-2 text-xs', active ? 'text-ink-700 font-medium' : 'text-ink-400')}>
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn('h-px flex-1 mx-3', i < idx ? 'bg-ink-700' : 'bg-ink-200')} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="bg-white border border-ink-200/60 rounded-3xl p-8 sm:p-10 shadow-subtle">
        {current === 'business' && (
          <Step
            title="Tell us about your business."
            subtitle="The basics. We'll use this everywhere — in content, ads, compliance."
          >
            <Input
              label="Business name"
              placeholder="Acme Dental"
              value={data.businessName}
              onChange={(e) => setData({ ...data, businessName: e.target.value })}
              required
            />
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">Industry</label>
              <select
                value={data.industry}
                onChange={(e) => setData({ ...data, industry: e.target.value })}
                className="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 text-base text-ink-700 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
              >
                <option value="">Choose an industry…</option>
                {INDUSTRIES.map((i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </div>
            <Input
              label="City / region"
              placeholder="Boston, MA"
              value={data.region}
              onChange={(e) => setData({ ...data, region: e.target.value })}
              required
            />
          </Step>
        )}

        {current === 'audience' && (
          <Step
            title="Who do you sell to?"
            subtitle="One sentence is enough. Maroa will refine this from your real customer reviews."
          >
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">Target audience</label>
              <textarea
                rows={3}
                placeholder="Families with kids ages 5–12 living within 5 miles of our office"
                value={data.audience}
                onChange={(e) => setData({ ...data, audience: e.target.value })}
                className="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 text-base text-ink-700 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
              />
            </div>
            <Input
              label="Primary goal"
              placeholder="Get 10 new patient bookings per month"
              value={data.goal}
              onChange={(e) => setData({ ...data, goal: e.target.value })}
              hint="What does success look like in 90 days?"
            />
          </Step>
        )}

        {current === 'connect' && (
          <Step
            title="Connect your accounts."
            subtitle="Optional, but skipping this means you'll review and post manually."
          >
            <ConnectButton
              label="Connect Meta (Instagram + Facebook)"
              description="Required to post to Instagram or run Meta ads."
              onClick={() => (window.location.href = '/api/oauth/meta/start')}
            />
            <ConnectButton
              label="Connect Google Ads"
              description="Required to audit and optimize Google ad campaigns."
              onClick={() => (window.location.href = '/api/oauth/google/start')}
            />
            <p className="text-sm text-ink-400 mt-4">
              You can connect these later from Settings. Move on when you&apos;re ready.
            </p>
          </Step>
        )}

        {current === 'voice' && (
          <Step
            title="What does your brand sound like?"
            subtitle="Paste 1–3 existing posts or copy you love. Maroa will learn from them."
          >
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">Voice samples</label>
              <textarea
                rows={8}
                placeholder="Paste anything that sounds like your brand — past posts, your website tagline, customer reviews you wrote…"
                value={data.voiceSeed}
                onChange={(e) => setData({ ...data, voiceSeed: e.target.value })}
                className="block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 text-base text-ink-700 placeholder:text-ink-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 font-mono text-sm"
              />
            </div>
            <p className="text-sm text-ink-400">
              No samples? That&apos;s fine — Maroa will use an industry default and refine over the first week.
            </p>
          </Step>
        )}

        {current === 'confirm' && (
          <Step
            title="Ready to launch."
            subtitle="Maroa will start drafting your first week of content right now. Nothing publishes without your approval."
          >
            <dl className="divide-y divide-ink-200 border border-ink-200 rounded-xl">
              <Row label="Business" value={data.businessName || '—'} />
              <Row label="Industry" value={data.industry || '—'} />
              <Row label="Region" value={data.region || '—'} />
              <Row label="Audience" value={data.audience || '—'} />
              <Row label="Goal" value={data.goal || '—'} />
            </dl>
            {error && <p className="text-sm text-red-600 mt-4">{error}</p>}
          </Step>
        )}

        {/* Footer nav */}
        <div className="flex items-center justify-between mt-10 pt-6 border-t border-ink-200">
          {idx > 0 ? (
            <Button variant="ghost" onClick={prev} disabled={submitting}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {idx < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={finish} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                <>Launch Maroa</>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-ink-700 tracking-tight">{title}</h2>
        <p className="mt-2 text-ink-400">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function ConnectButton({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-5 border border-ink-200 hover:border-accent-500 hover:bg-accent-50/40 rounded-xl transition-colors"
    >
      <p className="font-medium text-ink-700">{label}</p>
      <p className="text-sm text-ink-400 mt-1">{description}</p>
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm">
      <dt className="text-ink-400">{label}</dt>
      <dd className="col-span-2 text-ink-700">{value}</dd>
    </div>
  );
}
