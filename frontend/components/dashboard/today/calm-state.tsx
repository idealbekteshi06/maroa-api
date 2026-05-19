import { CheckCircle2 } from 'lucide-react';

/**
 * components/dashboard/today/calm-state.tsx
 * ---------------------------------------------------------------------------
 * Rendered in the "I need your help" slot when there's nothing pending.
 *
 * A clean empty state is the product working — the whole UI promise is
 * "I'll only bother you when I need to." So the empty state is
 * celebratory, not apologetic.
 * ---------------------------------------------------------------------------
 */

export function CalmState({ message }: { message?: string }) {
  return (
    <div className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 mb-4"
      >
        <CheckCircle2 className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <p className="text-lg text-ink-700 dark:text-ink-50 font-medium">
        Nothing for you to do right now.
      </p>
      <p className="mt-2 text-ink-500 dark:text-ink-300">
        {message || 'I’ll let you know the moment I need a yes or no.'}
      </p>
    </div>
  );
}
