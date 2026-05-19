import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * components/ui/select.tsx
 * ---------------------------------------------------------------------------
 * Native `<select>` wrapped to match the `<Input>` API exactly — same
 * label / hint / error / a11y wiring. Audit 2026-05-19 F25.
 *
 * Why a native select instead of a custom dropdown:
 *   - Accessibility comes for free (keyboard arrows, type-to-jump,
 *     screen-reader announcement, mobile native picker).
 *   - Zero JS for the component itself.
 *   - Matches what the platform does well — we restyle, not reinvent.
 *
 * Why this exists at all:
 *   - The onboarding industry/region selects were hand-rolled with
 *     duplicated border/focus/ring classes and no error-state pattern.
 *   - Every future select should drop in with the same shape as Input.
 *
 * Usage:
 *   <Select label="Industry" name="industry" error={errors.industry}>
 *     <option value="">Choose…</option>
 *     <option value="cafe">Café / Restaurant</option>
 *   </Select>
 * ---------------------------------------------------------------------------
 */

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, hint, error, id, children, ...props }, ref) => {
    const generatedId = React.useId();
    const selectId = id || generatedId;

    return (
      <div className="space-y-1.5">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-ink-700 dark:text-ink-100"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            id={selectId}
            ref={ref}
            className={cn(
              'block w-full appearance-none rounded-xl border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900',
              'px-4 py-3 pr-10 text-base text-ink-700 dark:text-ink-100',
              'focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20',
              'disabled:bg-ink-50 dark:disabled:bg-ink-800 disabled:text-ink-500',
              'transition-colors',
              error && 'border-red-500 focus:border-red-500 focus:ring-red-500/20',
              className,
            )}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={hint || error ? `${selectId}-desc` : undefined}
            {...props}
          >
            {children}
          </select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-500 dark:text-ink-300"
          />
        </div>
        {(hint || error) && (
          <p
            id={`${selectId}-desc`}
            role={error ? 'alert' : undefined}
            aria-live={error ? 'assertive' : undefined}
            className={cn(
              'text-sm',
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
Select.displayName = 'Select';
