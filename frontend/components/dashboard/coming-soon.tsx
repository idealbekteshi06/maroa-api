import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/**
 * Branded coming-soon surface for routes that exist in the nav but
 * don't have a UI yet. Better than 404. Shows what's coming, links to
 * the related ship-now alternative.
 */
export function ComingSoon({
  title,
  eyebrow,
  description,
  bullets,
  primary,
}: {
  title: string;
  eyebrow: string;
  description: string;
  bullets: string[];
  primary?: { label: string; href: string };
}) {
  return (
    <div className="max-w-3xl">
      <p className="text-eyebrow uppercase text-ink-400 mb-4">{eyebrow}</p>
      <h1 className="text-3xl font-semibold text-ink-700 dark:text-ink-50 tracking-tight">{title}</h1>
      <p className="mt-3 text-ink-400 max-w-2xl leading-relaxed">{description}</p>

      <div className="mt-8 rounded-2xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6">
        <p className="text-sm font-medium text-ink-700 dark:text-ink-100 mb-4">Coming in this view:</p>
        <ul className="space-y-2">
          {bullets.map((b) => (
            <li
              key={b}
              className="flex items-start gap-3 text-sm text-ink-700 dark:text-ink-100 leading-relaxed"
            >
              <span className="mt-2 h-1 w-1 rounded-full bg-ink-400 flex-shrink-0" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        {primary && (
          <Link
            href={primary.href}
            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-accent-500 hover:text-accent-600 dark:text-accent-400"
          >
            {primary.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </div>
  );
}
