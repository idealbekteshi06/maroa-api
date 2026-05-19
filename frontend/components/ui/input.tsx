import * as React from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, error, id, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id || generatedId;

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-ink-700 dark:text-ink-100">
            {label}
          </label>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            'block w-full rounded-xl border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-3 text-base text-ink-700 dark:text-ink-100 placeholder:text-ink-400',
            'focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20',
            'disabled:bg-ink-50 dark:disabled:bg-ink-800 disabled:text-ink-400',
            'transition-colors',
            error && 'border-red-500 focus:border-red-500 focus:ring-red-500/20',
            className,
          )}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={hint || error ? `${inputId}-desc` : undefined}
          {...props}
        />
        {(hint || error) && (
          <p
            id={`${inputId}-desc`}
            // Audit 2026-05-19 F13: errors must be announced by screen
            // readers. role="alert" + aria-live="assertive" do that without
            // depending on the parent setting focus.
            role={error ? 'alert' : undefined}
            aria-live={error ? 'assertive' : undefined}
            className={cn(
              'text-sm',
              // F8 contrast fix: ink-500 on light, ink-300 on dark.
              error ? 'text-red-600 dark:text-red-400' : 'text-ink-500 dark:text-ink-300',
            )}
          >
            {error || hint}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
