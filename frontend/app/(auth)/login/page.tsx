'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { logIn } from '@/lib/api/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email) {
      setError('Email is required.');
      return;
    }
    setLoading(true);
    try {
      await logIn({ email });
      setSent(true);
    } catch (err: any) {
      setError(err?.message || 'Log-in failed. Try again.');
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
          We sent a magic link to <span className="text-ink-700 font-medium">{email}</span>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold text-ink-700 tracking-tight mb-2">Welcome back</h1>
      <p className="text-ink-400 leading-relaxed mb-8">
        We&apos;ll send you a magic link. No passwords to forget.
      </p>

      <form onSubmit={onSubmit} className="space-y-5">
        <Input
          label="Email"
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
              Sending…
            </>
          ) : (
            'Send magic link'
          )}
        </Button>
      </form>

      <p className="mt-8 text-center text-sm text-ink-400">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-accent-500 hover:underline font-medium">
          Get started
        </Link>
      </p>
    </div>
  );
}
