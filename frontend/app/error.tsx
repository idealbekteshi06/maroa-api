'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCw, ArrowLeft } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Forward to your error tracker here (Sentry, etc.). For now: console.
    // eslint-disable-next-line no-console
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Something broke</p>
        <h1 className="text-display-lg text-ink-700 mb-6">We hit an unexpected error.</h1>
        <p className="text-xl text-ink-400 leading-relaxed mb-10">
          The team has been notified. You can retry the action, or head back home and try a different path.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Button onClick={reset} variant="primary" size="lg">
            <RotateCw className="h-4 w-4" />
            Try again
          </Button>
          <Button href="/" variant="ghost" size="lg">
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Button>
        </div>
        {error.digest && (
          <p className="mt-10 text-xs text-ink-400 font-mono">
            Error ID: <span className="text-ink-700">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  );
}
