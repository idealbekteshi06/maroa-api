import Link from 'next/link';
import { Logo } from '@/components/marketing/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      {/* Left: form */}
      <div className="flex flex-col">
        <header className="container py-6">
          <Logo />
        </header>
        <main id="main" className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-md">{children}</div>
        </main>
        <footer className="container py-6 text-xs text-ink-400 flex flex-wrap gap-4">
          <Link href="/privacy" className="hover:text-ink-700 dark:hover:text-ink-100">Privacy</Link>
          <Link href="/terms" className="hover:text-ink-700 dark:hover:text-ink-100">Terms</Link>
          <span>© {new Date().getFullYear()} Maroa</span>
        </footer>
      </div>

      {/* Right: editorial / brand panel (Apple-style — generous, restrained) */}
      <div className="hidden lg:flex bg-ink-700 dark:bg-ink-800 text-white p-12 flex-col justify-between">
        <div />
        <blockquote className="max-w-md">
          <p className="text-2xl font-medium leading-relaxed text-balance">
            &ldquo;It writes ad copy in my industry better than the agency I was paying $2k a month — and tells me why it chose each line.&rdquo;
          </p>
          <footer className="mt-6 text-sm text-ink-100/70">
            Owner — dental practice, Boston
          </footer>
        </blockquote>
        <div className="text-xs text-ink-100/50">
          7-day free trial · No credit card · Cancel anytime
        </div>
      </div>
    </div>
  );
}
