import type { Metadata } from 'next';
import { Mail, MessageSquare, Building2, Shield } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'How to reach Maroa — sales, support, security, privacy.',
  alternates: { canonical: '/contact' },
};

const CONTACTS = [
  {
    icon: Mail,
    label: 'General',
    email: 'hello@maroa.ai',
    description: 'Anything not covered below. We aim to reply within 1 business day.',
  },
  {
    icon: MessageSquare,
    label: 'Support',
    email: 'support@maroa.ai',
    description: 'For paid customers — questions about features, bugs, or your account.',
  },
  {
    icon: Building2,
    label: 'Sales',
    email: 'sales@maroa.ai',
    description: 'Multi-location, agency, or enterprise inquiries.',
  },
  {
    icon: Shield,
    label: 'Security disclosure',
    email: 'security@maroa.ai',
    description: 'Report a vulnerability. We respond within 24 hours and don\'t threaten researchers.',
  },
];

export default function ContactPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="max-w-3xl mx-auto text-center mb-16">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Contact</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50">Talk to a human.</h1>
        <p className="mt-6 text-xl text-ink-400 leading-relaxed">
          No bots, no ticket forms, no &quot;contact us&quot; chat widgets that turn into a chatbot. Real email
          addresses going to real inboxes.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto">
        {CONTACTS.map((c) => (
          <a
            key={c.label}
            href={`mailto:${c.email}`}
            className="block rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 hover:border-accent-500 hover:shadow-card transition-all"
          >
            <div className="h-10 w-10 rounded-xl bg-ink-100 dark:bg-ink-800 flex items-center justify-center mb-4">
              <c.icon className="h-5 w-5 text-ink-700 dark:text-ink-100" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-ink-400 mb-1">{c.label}</p>
            <p className="text-lg font-semibold text-ink-700 dark:text-ink-100">{c.email}</p>
            <p className="mt-2 text-sm text-ink-400 leading-relaxed">{c.description}</p>
          </a>
        ))}
      </div>

      <div className="max-w-3xl mx-auto mt-16 prose prose-lg dark:prose-invert text-ink-700 dark:text-ink-200 leading-relaxed">
        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mb-4">Office hours</h2>
        <p>
          We answer in CET (UTC+1/2). Same-day reply Mon–Fri; weekend emails Monday morning.
          For urgent production issues on paid plans, please mark the subject{' '}
          <code className="bg-ink-100 dark:bg-ink-800 px-2 py-1 rounded text-sm">[URGENT]</code>{' '}
          and we&apos;ll page on-call.
        </p>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">
          Press + partnerships
        </h2>
        <p>
          Email{' '}
          <a href="mailto:press@maroa.ai" className="text-accent-500 hover:underline">
            press@maroa.ai
          </a>
          .
        </p>

        <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">
          Legal entity
        </h2>
        <p className="text-ink-400">
          Maroa AI, Inc. · Delaware C-corp · EIN on request via{' '}
          <a href="mailto:legal@maroa.ai" className="text-accent-500 hover:underline">
            legal@maroa.ai
          </a>
          .
        </p>
      </div>
    </section>
  );
}
