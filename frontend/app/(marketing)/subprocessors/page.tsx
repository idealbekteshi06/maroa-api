import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sub-processors',
  description: 'Third-party vendors that process Maroa customer data.',
  alternates: { canonical: '/subprocessors' },
};

const SUBPROCESSORS = [
  {
    name: 'Supabase Inc.',
    purpose: 'Database hosting (PostgreSQL) + auth',
    location: 'US (primary) / EU (replica)',
    compliance: 'SOC 2 Type II, GDPR DPA in place',
    url: 'https://supabase.com/privacy',
  },
  {
    name: 'Railway Corp.',
    purpose: 'Application hosting (Node.js API + Next.js frontend)',
    location: 'US (us-west2)',
    compliance: 'SOC 2 Type II, GDPR DPA in place',
    url: 'https://railway.app/legal/dpa',
  },
  {
    name: 'Anthropic, PBC',
    purpose: 'AI text generation (Claude models)',
    location: 'US',
    compliance: 'Zero retention for Maroa accounts (Workspaces / Trust Center)',
    url: 'https://www.anthropic.com/legal/dpa',
  },
  {
    name: 'Paddle.com Market Limited',
    purpose: 'Payment processing + invoicing + tax compliance',
    location: 'UK / EU / US',
    compliance: 'PCI DSS Level 1, GDPR DPA in place',
    url: 'https://www.paddle.com/legal/dpa',
  },
  {
    name: 'Resend',
    purpose: 'Transactional email (account, billing, magic links)',
    location: 'US',
    compliance: 'GDPR DPA in place',
    url: 'https://resend.com/legal',
  },
  {
    name: 'Sentry / Functional Software, Inc.',
    purpose: 'Error monitoring (PII-scrubbed)',
    location: 'US / EU',
    compliance: 'SOC 2 Type II, GDPR DPA in place',
    url: 'https://sentry.io/legal/dpa/',
  },
  {
    name: 'Cloudflare, Inc.',
    purpose: 'CDN + DDoS protection',
    location: 'Global',
    compliance: 'SOC 2 Type II, ISO 27001, GDPR DPA in place',
    url: 'https://www.cloudflare.com/cloudflare-customer-dpa/',
  },
  {
    name: 'Higgsfield AI',
    purpose: 'Video / image generation (Cinema Studio + model routing)',
    location: 'US',
    compliance: 'DPA on request',
    url: 'https://higgsfield.ai/legal',
  },
  {
    name: 'Inngest, Inc.',
    purpose: 'Durable background jobs (cron + event-driven)',
    location: 'US',
    compliance: 'SOC 2 Type II',
    url: 'https://www.inngest.com/security',
  },
];

const LAST_UPDATED = 'May 16, 2026';

export default function SubprocessorsPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Legal</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-3">Sub-processors</h1>
        <p className="text-ink-400 mb-12">Last updated: {LAST_UPDATED}</p>

        <p className="text-xl text-ink-400 mb-12 leading-relaxed">
          These are the third-party vendors that process customer data on Maroa&apos;s behalf. Each has a
          signed DPA with equivalent privacy + security commitments to those we make to you.
        </p>

        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 dark:border-ink-800">
                <th className="text-left font-semibold text-ink-700 dark:text-ink-100 py-4 pr-6">
                  Vendor
                </th>
                <th className="text-left font-semibold text-ink-700 dark:text-ink-100 py-4 pr-6">
                  Purpose
                </th>
                <th className="text-left font-semibold text-ink-700 dark:text-ink-100 py-4 pr-6">
                  Location
                </th>
                <th className="text-left font-semibold text-ink-700 dark:text-ink-100 py-4">
                  Compliance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200/60 dark:divide-ink-800">
              {SUBPROCESSORS.map((s) => (
                <tr key={s.name}>
                  <td className="py-4 pr-6">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ink-700 dark:text-ink-100 hover:text-accent-500"
                    >
                      {s.name}
                    </a>
                  </td>
                  <td className="py-4 pr-6 text-ink-700 dark:text-ink-200">{s.purpose}</td>
                  <td className="py-4 pr-6 text-ink-400">{s.location}</td>
                  <td className="py-4 text-ink-400">{s.compliance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-16 prose prose-lg dark:prose-invert max-w-none text-ink-700 dark:text-ink-200 leading-relaxed">
          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">
            Notification of changes
          </h2>
          <p>
            We notify customers via email 30 days before adding a new sub-processor or changing the
            location of data processing. You may object during that window; if we can&apos;t reasonably
            accommodate the objection, you have the right to terminate without penalty.
          </p>
          <p>
            Subscribe to sub-processor updates at{' '}
            <a href="mailto:dpo@maroa.ai?subject=Subprocessor%20updates" className="text-accent-500 hover:underline">
              dpo@maroa.ai
            </a>.
          </p>
        </div>
      </div>
    </section>
  );
}
