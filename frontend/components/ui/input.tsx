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
          <label htmlFor={inputId} className="block text-sm font-medium text-ink-700">
            {label}
          </label>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            'block w-full rounded-xl border border-ink-300 bg-white px-4 py-3 text-base text-ink-700 placeholder:text-ink-400',
            'focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20',
            'disabled:bg-ink-50 disabled:text-ink-400',
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
            className={cn('text-sm', error ? 'text-red-600' : 'text-ink-400')}
          >
            {error || hint}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
