import Link from 'next/link';
import { ShieldCheck, Sparkles, Activity, Lock } from 'lucide-react';
import { Logo } from '@/components/marketing/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-white dark:bg-ink-950">
      {/* Left: form */}
      <div className="flex flex-col">
        <header className="container py-6">
          <Logo />
        </header>
        <main id="main" className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-md">{children}</div>
        </main>
        <footer className="container py-6 text-xs text-ink-400 flex flex-wrap gap-4">
          <Link href="/privacy" className="hover:text-ink-700 dark:hover:text-ink-100">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-ink-700 dark:hover:text-ink-100">
            Terms
          </Link>
          <Link href="/security" className="hover:text-ink-700 dark:hover:text-ink-100">
            Security
          </Link>
          <span>© {new Date().getFullYear()} Maroa</span>
        </footer>
      </div>

      {/* Right: product proof panel — what you'll see on the other side */}
      <div className="hidden lg:flex bg-ink-700 dark:bg-ink-900 text-white p-12 flex-col justify-between border-l border-ink-800 dark:border-ink-800">
        <div>
          <p className="text-eyebrow uppercase text-ink-100/60 mb-3">What&apos;s on the other side</p>
          <h2 className="text-3xl font-semibold leading-tight text-balance">
            A marketing OS that explains every move it makes.
          </h2>
          <p className="mt-4 text-ink-100/70 leading-relaxed max-w-md">
            Maroa runs content, ads, CRO, SEO, and reporting across every business you manage — and
            shows you the reasoning behind each decision before it ships.
          </p>
        </div>

        <ul className="space-y-5 max-w-md">
          <ProofRow
            icon={Sparkles}
            title="Reasoning trace on every output"
            body="Each draft links back to why — the hook, the angle, the past performance signal it&apos;s drawing from."
          />
          <ProofRow
            icon={ShieldCheck}
            title="Compliance gates built in"
            body="FDA, FTC, alcohol, finance — banned claims caught before they leave the gate."
          />
          <ProofRow
            icon={Activity}
            title="Auto-safe banding"
            body="Green auto-publishes. Yellow notifies. Red never ships without your signoff."
          />
          <ProofRow
            icon={Lock}
            title="Encrypted at rest, EU or US"
            body="OAuth tokens AES-256-GCM. Your choice of data residency. SOC 2 audit in progress."
          />
        </ul>

        <div className="text-xs text-ink-100/50">
          7-day free trial · No credit card · Cancel anytime
        </div>
      </div>
    </div>
  );
}

function ProofRow({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Sparkles;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-4">
      <div className="h-9 w-9 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
        <Icon className="h-4 w-4 text-white" strokeWidth={1.8} aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-ink-100/70 leading-snug mt-0.5">{body}</p>
      </div>
    </li>
  );
}
