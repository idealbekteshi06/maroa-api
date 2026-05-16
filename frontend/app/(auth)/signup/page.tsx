'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signUp } from '@/lib/api/auth';

export default function SignUpPage() {
  return (
    <Suspense fallback={<div className="h-12 w-full rounded-xl bg-ink-100 animate-pulse" aria-hidden />}>
      <SignUpInner />
    </Suspense>
  );
}

function SignUpInner() {
  const router = useRouter();
  const search = useSearchParams();
  const plan = search.get('plan') || 'free';

  const [email, setEmail] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !businessName) {
      setError('Email and business name are required.');
      return;
    }

    setLoading(true);
    try {
      await signUp({ email, businessName, plan });
      setSent(true);
    } catch (err: any) {
      setError(err?.message || 'Sign-up failed. Try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto h-14 w-14 rounded-xl bg-accent-50 flex items-center justify-center mb-6">
          <Mail className="h-7 w-7 text-accent-500" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold text-ink-700 mb-3">Check your inbox</h1>
        <p className="text-ink-400 leading-relaxed">
          We sent a magic link to <span className="text-ink-700 font-medium">{email}</span>. Click it to finish signing up.
        </p>
        <p className="mt-6 text-sm text-ink-400">
          Didn&apos;t get it? Check spam, or{' '}
          <button
            className="text-accent-500 hover:underline"
            onClick={() => setSent(false)}
          >
            try another email
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold text-ink-700 tracking-tight mb-2">Start your free trial</h1>
      <p className="text-ink-400 leading-relaxed mb-8">
        Seven days, no credit card, cancel anytime.
        {plan !== 'free' && (
          <>
            {' '}You selected the <strong className="text-ink-700 capitalize">{plan}</strong> plan.
          </>
        )}
      </p>

      <form onSubmit={onSubmit} className="space-y-5">
        <Input
          label="Business name"
          name="business-name"
          autoComplete="organization"
          placeholder="Acme Dental"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          required
        />
        <Input
          label="Work email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          error={error || undefined}
        />

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Sending magic link…
            </>
          ) : (
            'Send magic link'
          )}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-ink-400">
        Already have an account?{' '}
        <Link href="/login" className="text-accent-500 hover:underline font-medium">
          Log in
        </Link>
      </p>

      <p className="mt-8 text-xs text-ink-400 leading-relaxed">
        By continuing, you agree to our{' '}
        <Link href="/terms" className="underline hover:text-ink-700">Terms</Link>{' '}
        and{' '}
        <Link href="/privacy" className="underline hover:text-ink-700">Privacy Policy</Link>.
      </p>
    </div>
  );
}
