import Link from 'next/link';
import { cn } from '@/lib/cn';

interface LogoProps {
  className?: string;
  href?: string | null;
}

export function Logo({ className, href = '/' }: LogoProps) {
  const inner = (
    <span className={cn('inline-flex items-center gap-2 font-semibold text-ink-700 text-lg tracking-tight', className)}>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="text-ink-700"
      >
        <path d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="12" r="4" fill="currentColor" />
      </svg>
      Maroa
    </span>
  );

  if (href === null) return inner;
  return (
    <Link href={href} className="inline-flex items-center" aria-label="Maroa home">
      {inner}
    </Link>
  );
}
