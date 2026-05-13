import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'About — built for small businesses, by people who run one',
  description:
    'Maroa is built for the small businesses big marketing tools forgot. Cafés. Plumbers. Dental clinics. Local retail. Local SaaS.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">About</p>
        <h1 className="text-display-lg text-ink-700 mb-8">
          For the small businesses big marketing tools forgot.
        </h1>

        <div className="prose prose-lg max-w-none text-ink-700 leading-relaxed space-y-6">
          <p className="text-xl text-ink-400">
            Most AI marketing tools are built for SaaS teams with budget for both an in-house marketer and a generative tool.
            We built Maroa for the businesses on the other side: the café in Tirana, the family dental clinic in Boston, the
            plumber in West Roxbury, the boutique in Lisbon.
          </p>

          <p>
            For them, &ldquo;hire a marketer&rdquo; isn&apos;t an option. &ldquo;Buy software&rdquo; usually means another tool they have to babysit.
            What they actually need is a system that does the marketing work, knows their industry, doesn&apos;t embarrass them on
            compliance, and shows up Monday morning with the week&apos;s content already done.
          </p>

          <p>
            That&apos;s what Maroa is. Not an AI tool. A marketing operations system that runs week after week, audits ads daily,
            and shows you exactly why it wrote what it wrote.
          </p>

          <h2 className="text-display-md text-ink-700 mt-16 mb-6">What we believe</h2>

          <h3 className="text-xl font-semibold text-ink-700 mt-10 mb-3">
            Customer money is the only signal that matters.
          </h3>
          <p>
            We don&apos;t talk about &ldquo;awards.&rdquo; We don&apos;t talk about &ldquo;cutting edge.&rdquo; We talk about whether the ad you ran
            this week made you more money than the one you ran last week. Maroa is built to make that loop tighter and faster.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 mt-10 mb-3">
            Compliance is a feature, not a footnote.
          </h3>
          <p>
            Healthcare brands shouldn&apos;t accidentally claim cures. Financial advisors shouldn&apos;t accidentally guarantee returns.
            Maroa enforces 20 industry rulesets as hard refusals, not warnings — because a $50,000 FTC fine is a worse
            day than a rewrite.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 mt-10 mb-3">
            Local matters.
          </h3>
          <p>
            We treat 18 languages as first-class. We treat 49 regional markets as first-class. A Tirana café gets Albanian
            copy that reads like Tirana — not Google-Translated English with the word &ldquo;cozy&rdquo; in it.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 mt-10 mb-3">
            No black boxes.
          </h3>
          <p>
            Every piece of content Maroa produces comes with a reasoning trace. Which framework. Which audience stage.
            Which corpus examples influenced it. Which compliance gates it passed. You can override any choice and re-run.
            We owe you that transparency.
          </p>

          <h2 className="text-display-md text-ink-700 mt-16 mb-6">Where we are</h2>
          <p>
            Maroa is built by a small, focused team. We&apos;re launching with early customers and learning fast.
            If you run a small business and want to talk to the people building this, email us at{' '}
            <a href="mailto:hello@maroa.ai" className="text-accent-500 hover:underline">
              hello@maroa.ai
            </a>
            .
          </p>
        </div>

        <div className="mt-16 pt-16 border-t border-ink-200">
          <Button href="/signup" variant="primary" size="lg">
            Start free trial
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
