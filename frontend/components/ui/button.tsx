import * as React from 'react';
import Link from 'next/link';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 select-none',
  {
    variants: {
      variant: {
        // Solid black on light → solid white on dark (Apple invert)
        primary:
          'bg-ink-700 text-white hover:bg-ink-900 active:bg-ink-900 shadow-subtle hover:shadow-card ' +
          'dark:bg-white dark:text-ink-900 dark:hover:bg-ink-100 dark:active:bg-ink-200',
        // Apple "Buy" blue — for highest-conversion CTAs (same on both)
        accent: 'bg-accent-500 text-white hover:bg-accent-600 active:bg-accent-700 shadow-subtle hover:shadow-card',
        // Outline — secondary CTA
        outline:
          'border border-ink-300 text-ink-700 bg-white hover:bg-ink-50 hover:border-ink-400 ' +
          'dark:border-ink-700 dark:text-ink-100 dark:bg-ink-900 dark:hover:bg-ink-800 dark:hover:border-ink-600',
        // Ghost — tertiary action
        ghost:
          'text-ink-700 hover:bg-ink-100 ' +
          'dark:text-ink-100 dark:hover:bg-ink-800',
        // Link — inline text-like action
        link:
          'text-accent-500 hover:text-accent-600 underline-offset-4 hover:underline ' +
          'dark:text-accent-400 dark:hover:text-accent-300',
      },
      size: {
        sm: 'h-9 px-4 text-sm rounded-full',
        md: 'h-11 px-6 text-base rounded-full',
        lg: 'h-12 px-8 text-base rounded-full',
        xl: 'h-14 px-10 text-lg rounded-full',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  href?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, href, children, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));

    if (href) {
      // External vs internal
      const isExternal = href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:');
      if (isExternal) {
        return (
          <a href={href} className={classes} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      return (
        <Link href={href} className={classes}>
          {children}
        </Link>
      );
    }

    return (
      <button ref={ref} className={classes} {...props}>
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
