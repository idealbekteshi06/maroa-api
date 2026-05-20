'use client';

/**
 * components/dashboard/today/first-draft-banner.tsx
 * ---------------------------------------------------------------------------
 * The "magic moment" banner. Shows immediately after the customer finishes
 * onboarding (?first_draft=loading in the URL), runs through a 4-step
 * progress narrative, and disappears once the first generated_content row
 * lands (via Supabase Realtime — same channel today-shell uses) or after
 * 90 seconds, whichever is first.
 *
 * The point is psychological: instead of dropping into an empty dashboard
 * after a 60s LLM call, the customer watches Maroa narrate the steps it's
 * doing for them. By the time the animation finishes, the first draft is
 * already present below.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Sparkles, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const STEPS = [
  { label: 'Studying your business profile', ms: 8_000 },
  { label: 'Pulling the best examples in your industry', ms: 16_000 },
  { label: 'Drafting your first week of content', ms: 30_000 },
  { label: 'Running it through compliance + brand voice', ms: 12_000 },
];

const TOTAL_MS = STEPS.reduce((a, b) => a + b.ms, 0); // ≈ 66s

export function FirstDraftBanner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const enabled = searchParams.get('first_draft') === 'loading';
  const [stepIdx, setStepIdx] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let elapsed = 0;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < STEPS.length; i++) {
      elapsed += STEPS[i].ms;
      timeouts.push(
        setTimeout(() => {
          if (!cancelled) setStepIdx(Math.min(i + 1, STEPS.length));
        }, elapsed),
      );
    }
    timeouts.push(
      setTimeout(() => {
        if (!cancelled) setDone(true);
      }, TOTAL_MS),
    );
    return () => {
      cancelled = true;
      timeouts.forEach(clearTimeout);
    };
  }, [enabled]);

  // After done, give the user a moment to read, then clear the query string.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete('first_draft');
      router.replace(url.pathname + (url.search ? `?${url.searchParams.toString()}` : ''));
    }, 4_000);
    return () => clearTimeout(t);
  }, [done, router]);

  if (!enabled) return null;

  return (
    <div className="mb-6 rounded-2xl border border-accent-200/70 dark:border-accent-500/30 bg-gradient-to-br from-accent-50 to-white dark:from-accent-500/10 dark:to-ink-900 p-6 shadow-subtle overflow-hidden relative">
      <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-accent-500/10 blur-3xl pointer-events-none" />
      <div className="relative flex items-start gap-4">
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex h-12 w-12 items-center justify-center rounded-xl shrink-0',
            done
              ? 'bg-green-500/10 text-green-600 dark:text-green-300'
              : 'bg-accent-500/10 text-accent-600 dark:text-accent-300',
          )}
        >
          {done ? <CheckCircle2 className="h-6 w-6" /> : <Sparkles className="h-6 w-6 animate-pulse" />}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-ink-700 dark:text-ink-50">
            {done ? 'Your first week is ready.' : 'Maroa is setting things up for you.'}
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
            {done
              ? 'Scroll down to review the drafts. Nothing publishes without your approval.'
              : 'This usually takes about a minute. You can keep this tab open or come back later.'}
          </p>
          <ol className="mt-4 space-y-2">
            {STEPS.map((s, i) => {
              const status = i < stepIdx ? 'done' : i === stepIdx && !done ? 'active' : done ? 'done' : 'pending';
              return (
                <li
                  key={s.label}
                  className={cn(
                    'flex items-center gap-2.5 text-sm',
                    status === 'done' && 'text-ink-700 dark:text-ink-100',
                    status === 'active' && 'text-ink-700 dark:text-ink-50 font-medium',
                    status === 'pending' && 'text-ink-400 dark:text-ink-400',
                  )}
                >
                  <span aria-hidden="true" className="inline-flex h-4 w-4 items-center justify-center">
                    {status === 'done' ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                    ) : status === 'active' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-accent-500" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-ink-300 dark:bg-ink-600" />
                    )}
                  </span>
                  <span>{s.label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
