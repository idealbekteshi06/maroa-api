import * as React from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 shadow-subtle transition-shadow hover:shadow-card',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pt-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-xl font-semibold tracking-tight text-ink-700 dark:text-ink-100', className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  // Audit 2026-05-19 F8: text-ink-400 on white = 3.72:1 (fails WCAG AA).
  // ink-500 on white = ~5.4:1 (passes AA for body text). ink-300 on
  // dark surface = ~9.1:1 (well above AA).
  return (
    <p
      className={cn(
        'mt-2 text-ink-500 dark:text-ink-300 leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center px-6 pb-6 pt-4', className)} {...props} />;
}
