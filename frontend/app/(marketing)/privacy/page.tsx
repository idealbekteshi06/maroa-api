import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    'How Maroa collects, uses, and protects your data. GDPR-compliant, with EU + US processing options.',
  alternates: { canonical: '/privacy' },
};

const LAST_UPDATED = 'May 16, 2026';

export default function PrivacyPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Legal</p>
        <h1 className="text-display-lg text-ink-700 mb-3">Privacy Policy</h1>
        <p className="text-ink-400 mb-12">Last updated: {LAST_UPDATED}</p>

        <div className="prose prose-lg max-w-none text-ink-700 leading-relaxed space-y-6">
          <p className="text-xl text-ink-400">
            We take your data seriously. This page explains what Maroa collects, how we use it, and the
            controls you have. If anything here is unclear, email{' '}
            <a href="mailto:privacy@maroa.ai" className="text-accent-500 hover:underline">privacy@maroa.ai</a>{' '}
            and we&apos;ll fix the explanation.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">1. What we collect</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li><strong>Account data:</strong> email, business name, industry, region — required to operate the service.</li>
            <li><strong>Marketing data:</strong> the content you write, schedule, or publish through Maroa, plus performance data from connected platforms (Meta, Google, etc.).</li>
            <li><strong>OAuth tokens:</strong> when you connect Meta Ads, Google Ads, or social accounts. Encrypted at rest with AES-256-GCM.</li>
            <li><strong>Usage telemetry:</strong> page views, feature usage, error logs. Used to improve the product. No third-party advertising trackers.</li>
            <li><strong>Billing data:</strong> handled by Paddle (our payment processor); we never see card numbers.</li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">2. How we use it</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li>To operate the service you signed up for.</li>
            <li>To improve product features through aggregate, de-identified analysis.</li>
            <li>To send transactional emails (account, billing, security alerts).</li>
            <li>To detect abuse, fraud, or violations of our Terms.</li>
          </ul>
          <p>
            We do not sell your data. We do not share your data with third parties for their marketing
            purposes. We do not train shared AI models on your data — your data is used to generate output
            for <em>your</em> business, not to improve a global model.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">3. Sub-processors</h2>
          <p>
            We use a small number of vendors to operate Maroa. The full, up-to-date list is on{' '}
            <a href="/subprocessors" className="text-accent-500 hover:underline">our Subprocessors page</a>.
            Each is bound by a DPA with equivalent protections.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">4. Where your data lives</h2>
          <p>
            You can choose EU or US data residency at signup. We replicate database backups across at least
            two regions within your chosen geography. Backups are encrypted with keys we control.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">5. Your rights (GDPR + CCPA)</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li><strong>Access:</strong> request a copy of all data we hold about you. Self-serve export in Settings.</li>
            <li><strong>Erasure:</strong> close your account and we delete or anonymize within 30 days. Some records retained for legal compliance (tax, audit) for up to 7 years.</li>
            <li><strong>Portability:</strong> download everything Maroa has produced for you as a .zip from Settings → Danger zone.</li>
            <li><strong>Correction:</strong> edit account details anytime from Settings.</li>
            <li><strong>Restriction / objection:</strong> email <a href="mailto:privacy@maroa.ai" className="text-accent-500 hover:underline">privacy@maroa.ai</a>.</li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">6. Cookies</h2>
          <p>
            We use a small set of strictly-necessary cookies for authentication (Supabase session) and a
            single first-party analytics cookie (Plausible-style — no cross-site tracking). We do not use
            advertising cookies.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">7. Children</h2>
          <p>Maroa is not intended for users under 16. We do not knowingly collect data from minors.</p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">8. Security</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li>OAuth tokens encrypted at rest (AES-256-GCM).</li>
            <li>HTTPS everywhere with HSTS + preload.</li>
            <li>Row-level security enforced on every customer table.</li>
            <li>Magic-link authentication (no password reuse risk).</li>
            <li>Vulnerability disclosure: <a href="mailto:security@maroa.ai" className="text-accent-500 hover:underline">security@maroa.ai</a>.</li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">9. Changes to this policy</h2>
          <p>
            We&apos;ll notify you by email at least 30 days before any material change. Minor edits (typos,
            clarifications) ship without notice but show in the &quot;Last updated&quot; date.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 mt-12 mb-4">10. Contact</h2>
          <p>
            Data Protection contact:{' '}
            <a href="mailto:privacy@maroa.ai" className="text-accent-500 hover:underline">privacy@maroa.ai</a>.
            For EU residents, you can also lodge a complaint with your local supervisory authority.
          </p>
        </div>
      </div>
    </section>
  );
}
