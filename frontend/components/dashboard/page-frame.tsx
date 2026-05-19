import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * components/dashboard/page-frame.tsx
 * ---------------------------------------------------------------------------
 * Standard top-of-page header used by every non-home dashboard page.
 * Single-column, narrow-readable width, plain-English title + subtitle,
 * optional action slot on the right.
 *
 * Keeps the IA consistent so the customer always knows where they are:
 *   Home / Today (calm)        — /dashboard
 *   Approvals                  — /dashboard/approvals
 *   Content                    — /content
 *   Campaigns                  — /ads
 *   Clients                    — /dashboard/clients
 *   Reports                    — /dashboard/reports
 *   Settings                   — /settings
 * ---------------------------------------------------------------------------
 */

export interface PageFrameProps {
  eyebrow?: string;
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Allow the page to render full-bleed inside the dashboard layout. */
  wide?: boolean;
}

export function PageFrame({
  eyebrow,
  title,
  subtitle,
  action,
  children,
  wide = false,
}: PageFrameProps) {
  return (
    <div
      className={cn(
        'mx-auto px-5 sm:px-8 py-8 sm:py-12 space-y-8',
        wide ? 'max-w-6xl' : 'max-w-3xl',
      )}
    >
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          {eyebrow && (
            <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300 mb-2">
              {eyebrow}
            </p>
          )}
          <h1 className="text-display-md text-ink-700 dark:text-ink-50 tracking-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 text-lg text-ink-500 dark:text-ink-300 leading-relaxed max-w-2xl">
              {subtitle}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>

      <div className="space-y-6">{children}</div>
    </div>
  );
}
