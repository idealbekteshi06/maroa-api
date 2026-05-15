import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight, ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">404</p>
        <h1 className="text-display-lg text-ink-700 mb-6">This page slipped out the back.</h1>
        <p className="text-xl text-ink-400 leading-relaxed mb-10">
          We couldn&apos;t find what you were looking for. The link might be old, or we may have moved
          things around. Try one of these instead.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Button href="/" variant="primary" size="lg">
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Button>
          <Button href="/features" variant="ghost" size="lg">
            See features
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-10 text-sm text-ink-400">
          Or email{' '}
          <Link href="mailto:hello@maroa.ai" className="text-accent-500 hover:underline">
            hello@maroa.ai
          </Link>{' '}
          if you think this is a bug.
        </p>
      </div>
    </div>
  );
}
