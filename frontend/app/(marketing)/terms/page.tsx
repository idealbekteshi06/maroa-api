import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The legal agreement between you and Maroa.ai when you use the service.',
  alternates: { canonical: '/terms' },
};

const LAST_UPDATED = 'May 16, 2026';

export default function TermsPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Legal</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-3">Terms of Service</h1>
        <p className="text-ink-400 mb-12">Last updated: {LAST_UPDATED}</p>

        <div className="prose prose-lg dark:prose-invert max-w-none text-ink-700 dark:text-ink-200 leading-relaxed space-y-6">
          <p className="text-xl text-ink-400">
            By using Maroa, you agree to these Terms. They cover the rules of the service, what you can
            expect from us, and what we expect from you. Plain English; we don&apos;t hide anything in fine print.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">1. The service</h2>
          <p>
            Maroa is a marketing automation service for small businesses. We help you create content, run
            ads, and report on performance. We do not guarantee specific business outcomes (revenue, leads,
            engagement) — marketing depends on too many variables we don&apos;t control.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">2. Your account</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li>You must be 16 or older and legally able to contract.</li>
            <li>You&apos;re responsible for content you connect, schedule, or publish through Maroa.</li>
            <li>Keep your email + OAuth connections secure. Notify us at <a href="mailto:security@maroa.ai" className="text-accent-500 hover:underline">security@maroa.ai</a> on suspected compromise.</li>
            <li>One account per business unless you&apos;re on the Agency tier (multi-business included).</li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">3. Acceptable use</h2>
          <p>You agree NOT to use Maroa to:</p>
          <ul className="space-y-2 list-disc pl-6">
            <li>Send spam or unsolicited communications.</li>
            <li>Promote content that violates platform policies (Meta, Google, TikTok, etc.) or applicable law.</li>
            <li>Generate content that infringes others&apos; intellectual property, defames, harasses, or discriminates.</li>
            <li>Bypass or attempt to bypass our compliance gates, rate limits, or auth controls.</li>
            <li>Reverse-engineer, scrape, or build a competing product using our service.</li>
          </ul>
          <p>
            We may suspend or terminate accounts that violate this section. Severe or repeated violations
            result in immediate termination without refund.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">4. Compliance gates</h2>
          <p>
            Maroa applies industry compliance rulesets (FDA, FTC, FCA, ABA, fair-housing, etc.) and will
            REFUSE to ship copy that violates them. You acknowledge this is a feature, not a bug, and
            agree not to circumvent the gates.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">5. Pricing + billing</h2>
          <ul className="space-y-2 list-disc pl-6">
            <li>Pricing is on the <a href="/pricing" className="text-accent-500 hover:underline">/pricing</a> page. We may change prices with 30 days&apos; notice before your next renewal.</li>
            <li>Free trial: 7 days, no credit card. Cancel anytime during trial with no charge.</li>
            <li>Subscriptions auto-renew until you cancel. Cancel from Settings → Billing. Cancellation stops the next renewal; current period continues to end of cycle.</li>
            <li>Refunds: pro-rata refund within 14 days of first paid charge if you&apos;re unhappy. After 14 days, no refunds on the current period, but you can downgrade or cancel.</li>
            <li>Currency: USD. Payment processor: Paddle (handles tax + invoicing per your jurisdiction).</li>
          </ul>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">6. Your content + IP</h2>
          <p>
            Content you create, upload, or generate through Maroa stays yours. You grant us a limited
            license to store, process, and display it for the purpose of operating the service. We never
            use your content to train shared AI models. On account close, you can export everything; we
            then delete or anonymize within 30 days.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">7. AI-generated content</h2>
          <p>
            Maroa generates content using third-party AI providers (Anthropic Claude, etc.). You&apos;re
            responsible for reviewing AI-generated content before publishing. We provide a reasoning
            trace + compliance gates to help, but final responsibility for what you publish is yours.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">8. Availability + service levels</h2>
          <p>
            We aim for 99.5% uptime month-over-month. We don&apos;t commit to specific SLAs at current plan
            tiers. Status: <a href="/status" className="text-accent-500 hover:underline">/status</a>.
            Planned maintenance announced in advance via email + status page.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">9. Termination</h2>
          <p>
            You can close your account anytime from Settings → Danger zone. We may terminate accounts that
            violate these Terms or appear abandoned (12+ months no activity, after 30 days&apos; notice).
            On termination, all data deleted or anonymized within 30 days, with billing-record retention
            for tax compliance per applicable law (typically 7 years).
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">10. Disclaimers + liability</h2>
          <p>
            Maroa is provided &quot;as is.&quot; To the maximum extent permitted by law, we disclaim implied
            warranties of merchantability, fitness for a particular purpose, and non-infringement.
            Our aggregate liability is capped at the fees you paid us in the 12 months preceding the
            claim. Some jurisdictions don&apos;t allow these limitations; in that case, the limits apply
            to the extent permitted.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">11. Governing law</h2>
          <p>
            These Terms are governed by the laws of Delaware, USA (or the EU if you&apos;re an EU consumer,
            in which case mandatory consumer protections apply). Disputes resolved in Delaware courts or
            via binding arbitration (your choice).
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">12. Changes</h2>
          <p>
            We&apos;ll notify you 30 days before material changes. Continued use after the effective date
            constitutes acceptance. If you don&apos;t agree, close your account before the date.
          </p>

          <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mt-12 mb-4">13. Contact</h2>
          <p>
            Questions: <a href="mailto:hello@maroa.ai" className="text-accent-500 hover:underline">hello@maroa.ai</a>.
            Legal: <a href="mailto:legal@maroa.ai" className="text-accent-500 hover:underline">legal@maroa.ai</a>.
          </p>
        </div>
      </div>
    </section>
  );
}
