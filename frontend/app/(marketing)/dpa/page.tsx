import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Data Processing Agreement',
  description: 'GDPR-compliant DPA between Maroa and customers processing personal data.',
  alternates: { canonical: '/dpa' },
};

export default function DpaPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Legal</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-6">
          Data Processing Agreement
        </h1>

        <div className="prose prose-lg dark:prose-invert max-w-none text-ink-700 dark:text-ink-200 leading-relaxed space-y-6">
          <p className="text-xl text-ink-400">
            For customers processing personal data of EU/UK data subjects, this DPA forms a binding
            addendum to our Terms of Service.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">Quick links</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li><a href="/dpa/maroa-dpa-2026-05.pdf" className="text-accent-500 hover:underline">Download signed DPA (PDF)</a></li>
            <li><a href="/subprocessors" className="text-accent-500 hover:underline">Sub-processor list</a></li>
            <li><a href="/privacy" className="text-accent-500 hover:underline">Privacy Policy</a></li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">Key terms (summary)</h2>
          <dl className="space-y-6">
            <div>
              <dt className="font-semibold text-ink-700">Roles</dt>
              <dd className="mt-1">Customer = Controller. Maroa = Processor.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Scope of processing</dt>
              <dd className="mt-1">Only what&apos;s necessary to deliver the contracted service. Categories: contact info, marketing-campaign data, ad-platform metrics, content drafts.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Sub-processors</dt>
              <dd className="mt-1">Approved list at <a href="/subprocessors" className="text-accent-500 hover:underline">/subprocessors</a>. 30 days&apos; notice before adding a new sub-processor; objection process documented in the signed DPA.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">International transfers</dt>
              <dd className="mt-1">EU SCCs (2021/914) signed with all US-based sub-processors. UK addendum where applicable.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Security measures</dt>
              <dd className="mt-1">Encryption at rest (AES-256) and in transit (TLS 1.2+), RLS-enforced multi-tenancy, regular access review, magic-link auth (no password reuse risk).</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Sub-processor + breach notification</dt>
              <dd className="mt-1">Notification within 72 hours of confirmed personal-data breach affecting your data.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Audit rights</dt>
              <dd className="mt-1">Annual SOC 2-style report provided. Direct audits by arrangement (covered by NDA + advance notice).</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Data subject requests</dt>
              <dd className="mt-1">We assist within 5 business days on access / erasure / portability requests routed through you.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-700">Term + termination</dt>
              <dd className="mt-1">DPA runs concurrent with the service contract. On termination: delete or return data within 30 days; backups purged in next cycle.</dd>
            </div>
          </dl>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">How to execute the DPA</h2>
          <p>
            Email <a href="mailto:dpo@maroa.ai" className="text-accent-500 hover:underline">dpo@maroa.ai</a> from
            your business email. We&apos;ll send the counter-signed DPA back within 2 business days. For
            customers on the Agency tier, the DPA is auto-signed at the workspace level.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">Contact</h2>
          <p>
            Data Protection Officer:{' '}
            <a href="mailto:dpo@maroa.ai" className="text-accent-500 hover:underline">dpo@maroa.ai</a>.
            EU representative details on request.
          </p>
        </div>
      </div>
    </section>
  );
}
